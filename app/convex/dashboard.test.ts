import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearCapaImpl } from './peps';
import {
  crearMaterialPrueba, crearUsuarioPrueba, crearSesionPrueba, crearParametrosPrueba,
} from './testHelpers';
import { fechaOperativa, sumarDiasISO } from './lib/fechaOperativa';

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

  // EDS-88: el punto de reorden dejó de basarse en consumo REAL promedio
  // (por eso se elimina el viejo test de regresión que verificaba
  // exclusión de cierreConsumos no vigentes de ese promedio — ya no
  // existe ningún promedio real que calcular aquí). Ahora se prueba lo
  // contrario: que Panel de Control es un espejo EXACTO de Catálogo de
  // Materiales, incluso cuando hay cierres reales capturados (que ya no
  // deben influir en el resultado).
  test('EDS-88: getKPIsHoy.reorderKg es un espejo exacto de materiales.listCatalogo.reorderEnUso, sin importar el consumo real capturado', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, adminToken, operadorToken, adminId } = await setup(t);
    const matId = await crearMaterialPrueba(t, { leadTimeDias: 3, stockSeguridadDias: 5 });
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: matId, kgPorCarga: 10, nota: '', updatedAt: Date.now() }));
    await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 100000, costoUnitario: 1, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
      })
    );
    // Un cierre real con un consumo bien distinto al teórico — si el
    // dashboard todavía calculara con consumo real, reorderKg divergiría
    // del de Catálogo. No debe importar.
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 0,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 9999 }],
      token: operadorToken,
    });

    const kpis = await t.query(api.dashboard.getKPIsHoy, { token: comprasToken });
    const catalogo = await t.query(api.materiales.listCatalogo, { token: adminToken });
    const filaDashboard = kpis.materiales.find((m) => m.materialId === matId);
    const filaCatalogo = catalogo.find((m) => m.materialId === matId);

    // consumoDiario = 10 kgPorCarga × 8 cargasPorTurno × 2 turnosPorDia × 2 líneas = 320
    // reorder = 320 × (3 leadTime + 5 stockSeguridad) = 2560
    expect(filaCatalogo?.reorderEnUso).toBeCloseTo(2560, 5);
    expect(filaDashboard?.reorderKg).toBeCloseTo(filaCatalogo!.reorderEnUso!, 5);
    expect(filaDashboard?.coberturaDias).toBeCloseTo(filaDashboard!.existenciaKg / filaCatalogo!.consumoDiario, 5);
  });

  test('EDS-88: cambiar lineasActivas recalcula reorderKg igual en Catálogo y en Panel de Control', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { leadTimeDias: 0, stockSeguridadDias: 1 });
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: matId, kgPorCarga: 5, nota: '', updatedAt: Date.now() }));

    await t.mutation(api.parametros.updateParametros, { lineasActivas: 1, token: adminToken });

    const kpis = await t.query(api.dashboard.getKPIsHoy, { token: comprasToken });
    const catalogo = await t.query(api.materiales.listCatalogo, { token: adminToken });
    const filaDashboard = kpis.materiales.find((m) => m.materialId === matId);
    const filaCatalogo = catalogo.find((m) => m.materialId === matId);

    // consumoDiario = 5 × 8 × 2 × 1 línea = 80; reorder = 80 × (0+1) = 80
    expect(filaCatalogo?.reorderEnUso).toBeCloseTo(80, 5);
    expect(filaDashboard?.reorderKg).toBeCloseTo(80, 5);
  });

  test('% merma y costo real del último cierre usan las combinaciones línea×turno de la fecha de ese cierre', async () => {
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
    expect(kpis.produccionUltimoCierreKg).toBe(100);
    expect(kpis.produccionUltimoCierreMetros).toBe(25);
    expect(kpis.pctMermaUltimoCierre).toBeCloseTo((20 / 120) * 100, 5);
    expect(kpis.costoUltimoCierre).toBe(240); // 120kg × $2
    expect(kpis.costoRealPorKgUltimoCierre).toBeCloseTo(240 / 100, 5);
  });

  // EDS-90: en la operación real un turno se cierra horas o días después de
  // que terminó, así que "hoy" casi nunca tenía cierres capturados y estas
  // tarjetas quedaban en 0 casi todo el tiempo. Este test prueba justo el
  // caso que el código viejo (filtraba por fecha === hoy) fallaba: un
  // cierre capturado con fecha de AYER debe seguir poblando los KPIs,
  // usando esa fecha como referencia en vez de la de hoy.
  test('EDS-90: KPIs "de hoy" reflejan el último cierre capturado aunque su fecha no sea la de hoy', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, operadorToken, adminId } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    const ayer = sumarDiasISO(HOY, -1);
    await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 100000, costoUnitario: 2, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
      })
    );
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: ayer, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 25,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 120 }], // kgBuenos=100, merma=20
      token: operadorToken,
    });

    const kpis = await t.query(api.dashboard.getKPIsHoy, { token: comprasToken });
    expect(kpis.fecha).toBe(ayer);
    expect(kpis.produccionUltimoCierreKg).toBe(100);
    expect(kpis.produccionUltimoCierreMetros).toBe(25);
    expect(kpis.pctMermaUltimoCierre).toBeCloseTo((20 / 120) * 100, 5);
    expect(kpis.costoUltimoCierre).toBe(240); // 120kg × $2
    expect(kpis.costoRealPorKgUltimoCierre).toBeCloseTo(240 / 100, 5);
  });

  // EDS-75: reemplaza el texto estático "Actualizado con el cierre de
  // Turno 2 · 07/08/2026" que vivía hardcodeado en panel-control.html.
  test('ultimoCierre es null cuando todavía no se ha capturado ningún cierre', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);

    const kpis = await t.query(api.dashboard.getKPIsHoy, { token: comprasToken });
    expect(kpis.ultimoCierre).toBeNull();
  });

  test('ultimoCierre refleja el cierre insertado más recientemente (_creationTime), no el de fecha más reciente', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, operadorToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    const ayer = sumarDiasISO(HOY, -1);

    // Se captura primero el cierre de HOY...
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 10,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 0 }],
      token: operadorToken,
    });
    // ...y DESPUÉS se captura (tardíamente) el de AYER — _creationTime más
    // reciente, aunque su `fecha` sea más vieja. Si el código eligiera por
    // `fecha` en vez de `_creationTime`, este test fallaría (elegiría HOY).
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: ayer, linea: 2, turno: 2, cargasPreparadas: 1, metrosBuenos: 10,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 0 }],
      token: operadorToken,
    });

    const kpis = await t.query(api.dashboard.getKPIsHoy, { token: comprasToken });
    expect(kpis.ultimoCierre).toEqual({ fecha: ayer, linea: 2, turno: 2 });
  });
});

// EDS-66 (auditoría final de PR8): produccionPorRango/tendenciaMerma/
// tendenciaCosto/getObjetivos llaman requireRole(ctx, token, ROLES_DASHBOARD)
// exactamente igual que getKPIsHoy (revisado línea por línea en dashboard.ts)
// — pero solo getKPIsHoy tenía un test explícito de rechazo. Mismo patrón de
// código no es excusa para dejar sin regresión automática las otras 4
// funciones: si alguna llegara a perder esa línea en un refactor futuro,
// nada lo detectaría hasta que alguien probara manualmente. EDS-97 agrega
// kpisPorRango a la lista (mismo requireRole). EDS-99 agrega
// costoPromedioUltimosCierres (mismo requireRole, mismo ROLES_DASHBOARD).
describe('dashboard: rechazo de rol — produccionPorRango/tendenciaMerma/tendenciaCosto/getObjetivos/kpisPorRango/costoPromedioUltimosCierres (EDS-66/97/99)', () => {
  test('operador (sin vista de Panel de Control) es rechazado por las 6 funciones', async () => {
    const t = convexTest(schema, modules);
    const { operadorToken } = await setup(t);
    await expect(t.query(api.dashboard.produccionPorRango, { dias: 7, token: operadorToken })).rejects.toThrow();
    await expect(t.query(api.dashboard.tendenciaMerma, { dias: 7, token: operadorToken })).rejects.toThrow();
    await expect(t.query(api.dashboard.tendenciaCosto, { dias: 7, token: operadorToken })).rejects.toThrow();
    await expect(t.query(api.dashboard.getObjetivos, { token: operadorToken })).rejects.toThrow();
    await expect(t.query(api.dashboard.kpisPorRango, { dias: 7, token: operadorToken })).rejects.toThrow();
    await expect(t.query(api.dashboard.costoPromedioUltimosCierres, { n: 6, token: operadorToken })).rejects.toThrow();
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

  // EDS-98 — mismo hardening que ya tenía kpisPorRango (EDS-97, hallazgo
  // Major de CodeRabbit): sin cota superior ni chequeo de entero, un `dias`
  // fraccionario o absurdamente grande llegaba directo a cierresEnRango,
  // que hace `Array.from({length: dias}, ...)` — un valor enorme intenta
  // reservar un arreglo de ese tamaño antes de procesar nada.
  test('produccionPorRango/tendenciaMerma/tendenciaCosto rechazan dias fuera de 7/14/30 (incluye 0, fraccionario y absurdamente grande)', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    for (const fn of [api.dashboard.produccionPorRango, api.dashboard.tendenciaMerma, api.dashboard.tendenciaCosto]) {
      await expect(t.query(fn, { dias: 0, token: comprasToken })).rejects.toThrow();
      await expect(t.query(fn, { dias: 7.5, token: comprasToken })).rejects.toThrow();
      await expect(t.query(fn, { dias: 1_000_000_000, token: comprasToken })).rejects.toThrow();
    }
  });

  test('produccionPorRango/tendenciaMerma/tendenciaCosto aceptan exactamente 7, 14 y 30', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    for (const fn of [api.dashboard.produccionPorRango, api.dashboard.tendenciaMerma, api.dashboard.tendenciaCosto]) {
      for (const dias of [7, 14, 30]) {
        await expect(t.query(fn, { dias, token: comprasToken })).resolves.toBeDefined();
      }
    }
  });
});

// EDS-97 — pedido explícito del usuario: las tarjetas de % merma/producción
// (Calidad) y costo real/kg/metro (Gerencia) deben poder verse agregadas
// por un periodo (última semana, últimos 14/30 días), no solo el último
// cierre. kpisPorRango es la query que las alimenta.
describe('dashboard: kpisPorRango — KPIs agregados por periodo (EDS-97)', () => {
  test('agrega Σmerma/Σtotal y Σcosto/Σkg de VARIOS cierres — nunca un promedio de porcentajes diarios', async () => {
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
    const ayer = sumarDiasISO(HOY, -1);
    // Día 1 (ayer): kgBuenos=100, merma=20 (20% del día) — igual que el
    // test de "último cierre" de arriba.
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: ayer, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 25,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 120 }], // kgBuenos=100, merma=20
      token: operadorToken,
    });
    // Día 2 (hoy): kgBuenos=400, merma=0 (0% del día) — un día de mucho
    // volumen y cero merma. Un promedio simple de "20% y 0%" daría 10%;
    // el cálculo correcto (Σmerma/Σtotal) da 20/(120+400)=3.8%, muy
    // distinto — este test falla si algún día alguien "simplifica" a un
    // promedio de porcentajes diarios.
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 2, cargasPreparadas: 1, metrosBuenos: 100,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 400 }], // kgBuenos=400, merma=0
      token: operadorToken,
    });

    const r = await t.query(api.dashboard.kpisPorRango, { dias: 7, token: comprasToken });
    expect(r.produccionKg).toBe(500); // 100 + 400
    expect(r.produccionMetros).toBe(125); // 25 + 100
    expect(r.pctMerma).toBeCloseTo((20 / 520) * 100, 5); // Σmerma/Σtotal, NO (20+0)/2
    expect(r.costoTotal).toBe(120 * 2 + 400 * 2); // 1040
    expect(r.costoRealPorKg).toBeCloseTo(1040 / 500, 5);
    expect(r.costoRealPorMetro).toBeCloseTo(r.costoRealPorKg * 4, 5); // kgPorMetro=4 (crearParametrosPrueba)
    expect(r.dias).toBe(7);
    expect(r.fechaHasta).toBe(HOY);
  });

  test('sin cierres en el rango: todo en 0, sin dividir entre cero', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    const r = await t.query(api.dashboard.kpisPorRango, { dias: 30, token: comprasToken });
    expect(r.pctMerma).toBe(0);
    expect(r.produccionKg).toBe(0);
    expect(r.produccionMetros).toBe(0);
    expect(r.costoRealPorKg).toBe(0);
    expect(r.costoRealPorMetro).toBe(0);
  });

  test('un cierre fuera del rango pedido (más viejo que "dias") no se incluye', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, adminId } = await setup(t);
    // Se inserta el cierre directo (no vía crearCierreTurno, que solo
    // acepta hasta 7 días atrás) — aquí solo interesa que kpisPorRango
    // filtre bien por fecha, no ejercitar el flujo de captura completo.
    const hace10 = sumarDiasISO(HOY, -10);
    await t.run((ctx) => ctx.db.insert('cierresTurno', {
      fecha: hace10, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 25,
      caballetes105Pzas: 0, caballetes106Pzas: 0, kgBuenos: 100, caballetesKg: 0,
      mermaTotalKg: 0, trituradoKg: 0, costoTotalConsumido: 100, costoRealPorKg: 1, costoRealPorMetro: 4,
      capturadoPor: adminId, capturadoEn: Date.now(), editado: false, editadoPor: null, editadoEn: null,
      vecesRecapturado: 0,
    }));

    const r7 = await t.query(api.dashboard.kpisPorRango, { dias: 7, token: comprasToken });
    expect(r7.produccionKg).toBe(0); // el cierre de hace 10 días queda fuera de una ventana de 7

    const r14 = await t.query(api.dashboard.kpisPorRango, { dias: 14, token: comprasToken });
    expect(r14.produccionKg).toBe(100); // pero sí entra en una ventana de 14
  });

  // CodeRabbit (PR EDS-97): sin cota superior ni chequeo de entero, un
  // `dias` fraccionario o absurdamente grande llegaba directo a
  // `cierresEnRango`, que hace `Array.from({length: dias}, ...)` — un
  // valor enorme intenta reservar un arreglo de ese tamaño antes de
  // procesar nada. Se restringe a los 3 valores que la UI realmente ofrece.
  test('rechaza dias que no sea 7, 14 o 30 (incluye 0, fraccionario y absurdamente grande)', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(t.query(api.dashboard.kpisPorRango, { dias: 0, token: comprasToken })).rejects.toThrow();
    await expect(t.query(api.dashboard.kpisPorRango, { dias: 7.5, token: comprasToken })).rejects.toThrow();
    await expect(t.query(api.dashboard.kpisPorRango, { dias: 1_000_000_000, token: comprasToken })).rejects.toThrow();
  });

  test('acepta exactamente 7, 14 y 30', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    for (const dias of [7, 14, 30]) {
      await expect(t.query(api.dashboard.kpisPorRango, { dias, token: comprasToken })).resolves.toBeDefined();
    }
  });
});

// EDS-99 — "Costo real / kg y / metro" del Reporte Directivo pasó de
// promediarse por día natural a promediarse por los últimos N *cierres*
// reales, sin importar en cuántos días cayeron (pedido explícito del
// usuario tras revisar el PDF).
describe('dashboard: costoPromedioUltimosCierres (EDS-99)', () => {
  test('promedia Σcosto/Σkg (y Σcosto/Σmetros) de los últimos N cierres por _creationTime, no un promedio simple', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, adminId } = await setup(t);
    // 8 cierres insertados directo (orden de inserción = orden de
    // _creationTime en convex-test) — costoPromedioUltimosCierres debe
    // tomar solo los ÚLTIMOS 6, ignorando los 2 más viejos.
    const cierresBase = [
      { kgBuenos: 100, metrosBuenos: 25, costoTotalConsumido: 100 },  // el más viejo — fuera de los últimos 6
      { kgBuenos: 100, metrosBuenos: 25, costoTotalConsumido: 100 },  // el 2º más viejo — fuera de los últimos 6
      { kgBuenos: 100, metrosBuenos: 25, costoTotalConsumido: 200 },
      { kgBuenos: 200, metrosBuenos: 50, costoTotalConsumido: 300 },
      { kgBuenos: 50, metrosBuenos: 12.5, costoTotalConsumido: 100 },
      { kgBuenos: 300, metrosBuenos: 75, costoTotalConsumido: 450 },
      { kgBuenos: 150, metrosBuenos: 37.5, costoTotalConsumido: 225 },
      { kgBuenos: 100, metrosBuenos: 25, costoTotalConsumido: 150 },  // el más reciente
    ];
    for (const c of cierresBase) {
      await t.run((ctx) =>
        ctx.db.insert('cierresTurno', {
          fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 1,
          metrosBuenos: c.metrosBuenos, caballetes105Pzas: 0, caballetes106Pzas: 0,
          kgBuenos: c.kgBuenos, caballetesKg: 0, mermaTotalKg: 0, trituradoKg: 0,
          costoTotalConsumido: c.costoTotalConsumido, costoRealPorKg: 0, costoRealPorMetro: 0,
          capturadoPor: adminId, capturadoEn: Date.now(), editado: false, editadoPor: null,
          editadoEn: null, vecesRecapturado: 0,
        })
      );
    }
    const ultimos6 = cierresBase.slice(-6);
    const kgEsperado = ultimos6.reduce((s, c) => s + c.kgBuenos, 0);
    const metrosEsperado = ultimos6.reduce((s, c) => s + c.metrosBuenos, 0);
    const costoEsperado = ultimos6.reduce((s, c) => s + c.costoTotalConsumido, 0);

    const r = await t.query(api.dashboard.costoPromedioUltimosCierres, { n: 6, token: comprasToken });
    expect(r.n).toBe(6);
    expect(r.costoRealPorKg).toBeCloseTo(costoEsperado / kgEsperado, 5);
    expect(r.costoRealPorMetro).toBeCloseTo(costoEsperado / metrosEsperado, 5);
  });

  test('menos de N cierres existentes: usa los que haya, n refleja el conteo real', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken, adminId } = await setup(t);
    await t.run((ctx) =>
      ctx.db.insert('cierresTurno', {
        fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 25,
        caballetes105Pzas: 0, caballetes106Pzas: 0, kgBuenos: 100, caballetesKg: 0,
        mermaTotalKg: 0, trituradoKg: 0, costoTotalConsumido: 200, costoRealPorKg: 0, costoRealPorMetro: 0,
        capturadoPor: adminId, capturadoEn: Date.now(), editado: false, editadoPor: null,
        editadoEn: null, vecesRecapturado: 0,
      })
    );
    const r = await t.query(api.dashboard.costoPromedioUltimosCierres, { n: 6, token: comprasToken });
    expect(r.n).toBe(1);
    expect(r.costoRealPorKg).toBeCloseTo(2, 5);
  });

  test('sin cierres: todo en 0, sin dividir entre cero', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    const r = await t.query(api.dashboard.costoPromedioUltimosCierres, { n: 6, token: comprasToken });
    expect(r.n).toBe(0);
    expect(r.costoRealPorKg).toBe(0);
    expect(r.costoRealPorMetro).toBe(0);
  });

  test('rechaza n que no sea un entero positivo dentro de la cota (incluye 0, fraccionario y absurdamente grande)', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(t.query(api.dashboard.costoPromedioUltimosCierres, { n: 0, token: comprasToken })).rejects.toThrow();
    await expect(t.query(api.dashboard.costoPromedioUltimosCierres, { n: 6.5, token: comprasToken })).rejects.toThrow();
    await expect(t.query(api.dashboard.costoPromedioUltimosCierres, { n: 1_000_000_000, token: comprasToken })).rejects.toThrow();
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
