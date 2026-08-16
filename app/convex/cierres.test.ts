import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearCapaImpl } from './peps';
import { crearMaterialPrueba, crearUsuarioPrueba, crearSesionPrueba, crearParametrosPrueba } from './testHelpers';
import { fechaOperativa, sumarDiasISO } from './lib/fechaOperativa';

const modules = import.meta.glob('./**/*.ts');

// "Hoy" tiene que calcularse igual que crearCierreTurno lo valida
// (validarFechaOperativaEnVentana, ventana de 7 días atrás desde la fecha
// operativa REAL) — un literal fijo como '2026-08-08' solo pasa mientras
// el suite corra dentro de esos 7 días de esa fecha; cualquier día
// después, cae fuera de la ventana y el test empieza a fallar sin que
// nada del código real haya cambiado (encontrado real: EDS-95). Mismo
// patrón ya usado en dashboard.test.ts/alertas.test.ts.
const HOY = fechaOperativa(Date.now(), 'America/Mexico_City', '06:00');

async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
  await crearParametrosPrueba(t, 4);
  const trituradoId = await crearMaterialPrueba(t, { slug: 'triturado', esInterno: true });
  const matAId = await crearMaterialPrueba(t, { esInterno: false });
  const operadorId = await crearUsuarioPrueba(t, 'operador');
  const adminId = await crearUsuarioPrueba(t, 'admin');
  const operadorToken = await crearSesionPrueba(t, operadorId);
  const adminToken = await crearSesionPrueba(t, adminId);
  await t.run((ctx) =>
    crearCapaImpl(ctx, {
      materialId: matAId, kgOriginal: 500, costoUnitario: 5, fechaEntrada: 1000,
      origen: 'entrada', entradaId: null, cierreTurnoId: null,
      origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
    })
  );
  return { matAId, trituradoId, operadorToken, adminToken, adminId };
}

describe('cierres: crearCierreTurno usa el motor compartido, sin duplicar PEPS (tarea 4.2)', () => {
  test('cierre nuevo: usa el motor de cierreEngine y aplica PEPS real', async () => {
    const t = convexTest(schema, modules);
    const { matAId, operadorToken } = await setup(t);

    const r = await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }],
      token: operadorToken,
    });
    expect(r.yaExistia).toBe(false);

    const cierre = await t.run((ctx) => ctx.db.get(r.cierreTurnoId));
    expect(cierre?.kgBuenos).toBe(160);
    expect(cierre?.costoTotalConsumido).toBe(180 * 5);
    expect(cierre?.trituradoKg).toBe(20);

    const capaA = await t.run((ctx) => ctx.db.get(matAId).then(() => ctx.db.query('capasCosto').withIndex('by_material_fecha', (q) => q.eq('materialId', matAId)).first()));
    expect(capaA?.kgRestante).toBe(320); // 500 - 180
  });

  test('primer llamado sin confirmarRecierre solo avisa, no duplica el consumo', async () => {
    const t = convexTest(schema, modules);
    const { matAId, operadorToken } = await setup(t);

    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }],
      token: operadorToken,
    });

    const r2 = await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }],
      token: operadorToken, // sin confirmarRecierre
    });
    expect(r2.yaExistia).toBe(true);
    expect((r2 as any).recierreAplicado).toBeUndefined();

    const cierres = await t.run((ctx) => ctx.db.query('cierresTurno').collect());
    expect(cierres).toHaveLength(1); // sigue siendo UN solo documento

    const capaA = await t.run((ctx) => ctx.db.query('capasCosto').withIndex('by_material_fecha', (q) => q.eq('materialId', matAId)).first());
    expect(capaA?.kgRestante).toBe(320); // no se volvió a descontar
  });

  test('BUG DE INTEGRIDAD REGRESIÓN: recierre con confirmarRecierre NO duplica el consumo (un solo documento, un solo descuento)', async () => {
    const t = convexTest(schema, modules);
    const { matAId, operadorToken } = await setup(t);

    const r1 = await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }],
      token: operadorToken,
    });

    const r2 = await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 35,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 150 }],
      confirmarRecierre: true, token: operadorToken,
    });

    expect(r2.cierreTurnoId).toBe(r1.cierreTurnoId); // MISMO documento, no uno nuevo

    const cierres = await t.run((ctx) => ctx.db.query('cierresTurno').collect());
    expect(cierres).toHaveLength(1);

    const capaA = await t.run((ctx) => ctx.db.query('capasCosto').withIndex('by_material_fecha', (q) => q.eq('materialId', matAId)).first());
    // 500 - 150 (consumo neto del segundo cierre) — NO 500 - 180 - 150, que
    // sería el resultado si el recierre hubiera duplicado el descuento.
    expect(capaA?.kgRestante).toBe(350);

    const cierre = await t.run((ctx) => ctx.db.get(r1.cierreTurnoId));
    expect(cierre?.editado).toBe(true);
    expect(cierre?.vecesRecapturado).toBe(1);

    const historial = await t.run((ctx) => ctx.db.query('correccionesHistorial').collect());
    expect(historial).toHaveLength(1);
    expect(historial[0].motivo).toBe('recierre_duplicado');
    expect(JSON.parse(historial[0].snapshotAntes).metrosBuenos).toBe(40);
    expect(JSON.parse(historial[0].snapshotDespues).metrosBuenos).toBe(35);
  });

  test('rechaza cargasPreparadas negativo', async () => {
    const t = convexTest(schema, modules);
    const { matAId, operadorToken } = await setup(t);
    await expect(
      t.mutation(api.cierres.crearCierreTurno, {
        fecha: HOY, linea: 1, turno: 1, cargasPreparadas: -1, metrosBuenos: 40,
        caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 10 }],
        token: operadorToken,
      })
    ).rejects.toThrow(/cargasPreparadas no puede ser negativo/);
  });

  test('gerencia (rol no permitido) no puede crear cierre', async () => {
    const t = convexTest(schema, modules);
    const { matAId } = await setup(t);
    const gerenciaId = await crearUsuarioPrueba(t, 'gerencia');
    const gerenciaToken = await crearSesionPrueba(t, gerenciaId);
    await expect(
      t.mutation(api.cierres.crearCierreTurno, {
        fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
        caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 10 }],
        token: gerenciaToken,
      })
    ).rejects.toThrow();
  });
});

describe('cierres: estadoCierresDelDia / consumoEsperado (tarea 4.1)', () => {
  test('estadoCierresDelDia refleja las 4 combinaciones y marca la cerrada', async () => {
    const t = convexTest(schema, modules);
    const { matAId, operadorToken } = await setup(t);
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 10 }],
      token: operadorToken,
    });

    const estado = await t.query(api.cierres.estadoCierresDelDia, { fecha: HOY, token: operadorToken });
    expect(estado).toHaveLength(4);
    const l1t1 = estado.find((e) => e.linea === 1 && e.turno === 1);
    const l1t2 = estado.find((e) => e.linea === 1 && e.turno === 2);
    expect(l1t1?.cerrado).toBe(true);
    expect(l1t2?.cerrado).toBe(false);
  });

  test('consumoEsperado usa la fórmula real por carga', async () => {
    const t = convexTest(schema, modules);
    const { operadorToken } = await setup(t);
    const matBId = await crearMaterialPrueba(t, { esInterno: false });
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: matBId, kgPorCarga: 25, nota: '', updatedAt: Date.now() }));

    const resultado = await t.query(api.cierres.consumoEsperado, { cargasPreparadas: 8, token: operadorToken });
    const fila = resultado.find((r) => r.materialId === matBId);
    expect(fila?.kgEsperado).toBe(200); // 25 * 8
  });
});

// EDS-83: encontrado real — el usuario capturó el primer cierre real
// tarde (la noche siguiente) y quedó fechado el día equivocado porque
// nada validaba `fecha` en el servidor. Estas pruebas ejercitan la
// mutation real, no solo la función pura (esa cobertura vive en
// tiempo.test.ts).
describe('cierres: crearCierreTurno valida fecha en servidor (EDS-83)', () => {
  test('rechaza una fecha futura', async () => {
    const t = convexTest(schema, modules);
    const { matAId, operadorToken } = await setup(t);
    const manana = sumarDiasISO(fechaOperativa(Date.now(), 'America/Mexico_City', '06:00'), 1);

    await expect(
      t.mutation(api.cierres.crearCierreTurno, {
        fecha: manana, linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
        caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }],
        token: operadorToken,
      })
    ).rejects.toThrow(/fecha futura/);

    expect(await t.run((ctx) => ctx.db.query('cierresTurno').collect())).toHaveLength(0);
  });

  test('rechaza una fecha de hace más de 7 días (captura tardía fuera de ventana)', async () => {
    const t = convexTest(schema, modules);
    const { matAId, operadorToken } = await setup(t);
    const hace8 = sumarDiasISO(fechaOperativa(Date.now(), 'America/Mexico_City', '06:00'), -8);

    await expect(
      t.mutation(api.cierres.crearCierreTurno, {
        fecha: hace8, linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
        caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }],
        token: operadorToken,
      })
    ).rejects.toThrow(/hasta 7 días atrás/);

    expect(await t.run((ctx) => ctx.db.query('cierresTurno').collect())).toHaveLength(0);
  });
});
