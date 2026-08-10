import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearCapaImpl } from './peps';
import {
  crearMaterialPrueba, crearUsuarioPrueba, crearSesionPrueba, crearParametrosPrueba,
} from './testHelpers';
import { fechaOperativa } from './lib/fechaOperativa';

const modules = import.meta.glob('./**/*.ts');

// "Hoy" tiene que calcularse igual que dashboard.ts lo calcula (fecha
// operativa real, no un literal fijo) — de lo contrario estos tests solo
// pasan por coincidencia mientras corran el mismo día calendario que se
// escribieron, y fallan (o dejan de probar "hoy" de verdad) cualquier otro
// día o en otro huso horario (mayor de la auditoría de PR 4). Mismos
// horaInicioTurno1/zonaHoraria que crearParametrosPrueba().
const HOY = fechaOperativa(Date.now(), 'America/Mexico_City', '06:00');

async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
  await crearParametrosPrueba(t, 4);
  await crearMaterialPrueba(t, { slug: 'triturado', esInterno: true }); // requerido por aplicarCierreImpl
  const compradorId = await crearUsuarioPrueba(t, 'compras');
  const operadorId = await crearUsuarioPrueba(t, 'operador');
  const adminId = await crearUsuarioPrueba(t, 'admin');
  const comprasToken = await crearSesionPrueba(t, compradorId);
  const operadorToken = await crearSesionPrueba(t, operadorId);
  const adminToken = await crearSesionPrueba(t, adminId);
  return { compradorId, operadorId, adminId, comprasToken, operadorToken, adminToken };
}

describe('dashboard: getKPIsHoy (tarea 6.1)', () => {
  test('operador (sin vista de Panel de Control) no puede leer KPIs', async () => {
    const t = convexTest(schema, modules);
    const { operadorToken } = await setup(t);
    await expect(t.query(api.dashboard.getKPIsHoy, { token: operadorToken })).rejects.toThrow();
  });

  test('existencia y valor de inventario se derivan de capasCosto reales', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, adminId } = await setup(t);
    const matId = await crearMaterialPrueba(t, { esInterno: false, esSustituto: false, leadTimeDias: 0, stockSeguridadDias: 0 });
    await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 500, costoUnitario: 10, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
      })
    );

    const kpis = await t.query(api.dashboard.getKPIsHoy, { token: comprasToken });
    const fila = kpis.materiales.find((m) => m.materialId === matId);
    expect(fila?.existenciaKg).toBe(500);
    expect(fila?.valorKg).toBe(5000);
    expect(kpis.valorInventarioTotal).toBeGreaterThanOrEqual(5000);
  });

  test('Triturado (esInterno) y HDPE virgen (esSustituto) no tienen punto de reorden', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    const trituradoId = await crearMaterialPrueba(t, { esInterno: true });
    const virgenId = await crearMaterialPrueba(t, { esSustituto: true });

    const kpis = await t.query(api.dashboard.getKPIsHoy, { token: comprasToken });
    const triturado = kpis.materiales.find((m) => m.materialId === trituradoId);
    const virgen = kpis.materiales.find((m) => m.materialId === virgenId);
    expect(triturado?.reorderKg).toBeNull();
    expect(triturado?.status).toBe('neutral');
    expect(virgen?.reorderKg).toBeNull();
    expect(virgen?.status).toBe('neutral');
  });

  test('material en modo reorden manual usa reorderManualKg, no el calculado', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, adminId } = await setup(t);
    const matId = await crearMaterialPrueba(t, { reorderMode: 'manual', reorderManualKg: 999999 });
    await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 10000, costoUnitario: 1, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
      })
    );

    const kpis = await t.query(api.dashboard.getKPIsHoy, { token: comprasToken });
    const fila = kpis.materiales.find((m) => m.materialId === matId);
    // 10,000 kg de existencia sigue siendo "crítico" porque el override
    // manual (999,999) es absurdamente alto — confirma que se usó el
    // override y no el cálculo automático (que con 0 consumo daría 0).
    expect(fila?.reorderKg).toBe(999999);
    expect(fila?.status).toBe('crit');
  });

  test('BUG DE INTEGRIDAD REGRESIÓN: el consumo diario promedio ignora cierreConsumos con vigente:false (recierre)', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, operadorToken, adminId } = await setup(t);
    const matId = await crearMaterialPrueba(t, { leadTimeDias: 1, stockSeguridadDias: 0 });
    await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 100000, costoUnitario: 1, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
      })
    );

    // Primer cierre: consume 1400 kg (queda vigente:false tras el recierre).
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 0,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 1400 }],
      token: operadorToken,
    });
    // Recierre del MISMO turno: consume solo 14 kg — el registro de 1400kg
    // queda vigente:false, el de 14kg queda vigente:true.
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 0,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 14 }],
      confirmarRecierre: true, token: operadorToken,
    });

    // Verificación de control: SÍ existe una fila vigente:false de 1400kg.
    const consumos = await t.run((ctx) => ctx.db.query('cierreConsumos').collect());
    expect(consumos.some((c) => c.kgConsumido === 1400 && c.vigente === false)).toBe(true);
    expect(consumos.some((c) => c.kgConsumido === 14 && c.vigente === true)).toBe(true);

    const kpis = await t.query(api.dashboard.getKPIsHoy, { token: comprasToken });
    const fila = kpis.materiales.find((m) => m.materialId === matId);
    // consumoDiarioPromedio = 14kg / 14 días = 1kg/día → reorder = 1×(1+0) = 1kg.
    // Si el bug existiera (sumara también los 1400kg vigente:false),
    // reorder saldría ~100× más grande.
    expect(fila?.reorderKg).toBeCloseTo(1, 5);
  });

  test('% merma y costo real de hoy usan las 4 combinaciones línea×turno de hoy', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, operadorToken, adminId } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 100000, costoUnitario: 2, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
      })
    );
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 25,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 120 }], // kgBuenos=100, merma=20
      token: operadorToken,
    });

    const kpis = await t.query(api.dashboard.getKPIsHoy, { token: comprasToken });
    expect(kpis.produccionHoyKg).toBe(100);
    expect(kpis.produccionHoyMetros).toBe(25);
    expect(kpis.pctMermaHoy).toBeCloseTo((20 / 120) * 100, 5);
    expect(kpis.costoRealHoy).toBe(240); // 120kg × $2
    expect(kpis.costoRealPorKgHoy).toBeCloseTo(240 / 100, 5);
  });
});

// EDS-66 (auditoría final de PR8): produccionPorRango/tendenciaMerma/
// tendenciaCosto/getObjetivos llaman requireRole(ctx, token, ROLES_DASHBOARD)
// exactamente igual que getKPIsHoy (revisado línea por línea en dashboard.ts)
// — pero solo getKPIsHoy tenía un test explícito de rechazo. Mismo patrón de
// código no es excusa para dejar sin regresión automática las otras 4
// funciones: si alguna llegara a perder esa línea en un refactor futuro,
// nada lo detectaría hasta que alguien probara manualmente.
describe('dashboard: rechazo de rol — produccionPorRango/tendenciaMerma/tendenciaCosto/getObjetivos (EDS-66)', () => {
  test('operador (sin vista de Panel de Control) es rechazado por las 4 funciones', async () => {
    const t = convexTest(schema, modules);
    const { operadorToken } = await setup(t);
    await expect(t.query(api.dashboard.produccionPorRango, { dias: 7, token: operadorToken })).rejects.toThrow();
    await expect(t.query(api.dashboard.tendenciaMerma, { dias: 7, token: operadorToken })).rejects.toThrow();
    await expect(t.query(api.dashboard.tendenciaCosto, { dias: 7, token: operadorToken })).rejects.toThrow();
    await expect(t.query(api.dashboard.getObjetivos, { token: operadorToken })).rejects.toThrow();
  });
});

describe('dashboard: series históricas (tarea 6.2)', () => {
  test('produccionPorRango devuelve el largo correcto y agrupa por línea/turno', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, operadorToken, adminId } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 100000, costoUnitario: 1, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
      })
    );
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 2, cargasPreparadas: 1, metrosBuenos: 44,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 44 }],
      token: operadorToken,
    });

    const serie = await t.query(api.dashboard.produccionPorRango, { dias: 14, token: comprasToken });
    expect(serie).toHaveLength(14);
    const hoy = serie.find((d) => d.fecha === HOY);
    expect(hoy?.linea1Turno2).toBe(44);
    expect(hoy?.linea1Turno1).toBe(0);
  });

  test('tendenciaMerma y tendenciaCosto son coherentes entre sí para el mismo día', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, operadorToken, adminId } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 100000, costoUnitario: 3, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
      })
    );
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 2, turno: 1, cargasPreparadas: 1, metrosBuenos: 20,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 100 }], // kgBuenos=80, merma=20
      token: operadorToken,
    });

    const merma = await t.query(api.dashboard.tendenciaMerma, { dias: 7, token: comprasToken });
    const costo = await t.query(api.dashboard.tendenciaCosto, { dias: 7, token: comprasToken });
    expect(merma).toHaveLength(7);
    expect(costo).toHaveLength(7);
    const mermaHoy = merma.find((d) => d.fecha === HOY);
    const costoHoy = costo.find((d) => d.fecha === HOY);
    expect(mermaHoy?.pctMerma).toBeCloseTo(20, 5); // 20/100*100
    expect(costoHoy?.costoRealPorKg).toBeCloseTo(300 / 80, 5); // 100kg*$3 / 80kg buenos
  });

  test('rechaza dias <= 0', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(t.query(api.dashboard.produccionPorRango, { dias: 0, token: comprasToken })).rejects.toThrow();
  });
});

describe('dashboard: objetivos de producción (tarea 6.5)', () => {
  test('getObjetivos devuelve ceros si nunca se ha configurado', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    const obj = await t.query(api.dashboard.getObjetivos, { token: comprasToken });
    expect(obj.turnoL1).toBe(0);
  });

  test('updateObjetivos persiste — leerlo de nuevo conserva el valor', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, adminToken } = await setup(t);
    await t.mutation(api.dashboard.updateObjetivos, { turnoL1: 160, turnoL2: 155, semana: 4400, mes: 19000, token: adminToken });
    const obj = await t.query(api.dashboard.getObjetivos, { token: comprasToken });
    expect(obj).toMatchObject({ turnoL1: 160, turnoL2: 155, semana: 4400, mes: 19000 });
  });

  test('solo admin puede escribir objetivos', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(
      t.mutation(api.dashboard.updateObjetivos, { turnoL1: 1, turnoL2: 1, semana: 1, mes: 1, token: comprasToken })
    ).rejects.toThrow();
  });

  test('rechaza metas negativas', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await expect(
      t.mutation(api.dashboard.updateObjetivos, { turnoL1: -1, turnoL2: 1, semana: 1, mes: 1, token: adminToken })
    ).rejects.toThrow(/negativas/);
  });
});
