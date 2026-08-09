import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { aplicarCierreImpl, revertirCierreImpl } from './cierreEngine';
import { crearMaterialPrueba, crearUsuarioPrueba, crearParametrosPrueba, crearCierreDummy, getCapa, getMovimientos } from './testHelpers';

const modules = import.meta.glob('./**/*.ts');

// aplicarCierreImpl busca el Triturado por slug fijo "triturado" — cada
// test crea el suyo con ese slug exacto en su propio backend aislado.
async function setupBase(t: Awaited<ReturnType<typeof convexTest>>) {
  await crearParametrosPrueba(t, 4); // kgPorMetro = 4
  const trituradoId = await crearMaterialPrueba(t, { slug: 'triturado', esInterno: true });
  const matAId = await crearMaterialPrueba(t, { esInterno: false });
  const userId = await crearUsuarioPrueba(t, 'admin');
  return { trituradoId, matAId, userId };
}

async function sembrarCapaMatA(t: any, matAId: any, userId: any, kg = 200, costo = 5) {
  const { crearCapaImpl } = await import('./peps');
  return t.run((ctx: any) =>
    crearCapaImpl(ctx, {
      materialId: matAId, kgOriginal: kg, costoUnitario: costo, fechaEntrada: 1000,
      origen: 'entrada', entradaId: null, cierreTurnoId: null,
      origenTipo: 'entrada', origenId: 'setup', createdBy: userId,
    })
  );
}

describe('cierreEngine: motor de aplicar/revertir cierre (tarea 3.2)', () => {
  test('rechaza metrosBuenos negativo', async () => {
    const t = convexTest(schema, modules);
    const { userId } = await setupBase(t);
    const cierreId = await crearCierreDummy(t, userId);
    await expect(
      t.run((ctx) => aplicarCierreImpl(ctx, { cierreTurnoId: cierreId, metrosBuenos: -1, caballetes105Pzas: 0, caballetes106Pzas: 0, consumoPorMaterial: [], createdBy: userId }))
    ).rejects.toThrow(/metrosBuenos no puede ser negativo/);
  });

  test('rechaza caballetes negativos', async () => {
    const t = convexTest(schema, modules);
    const { userId } = await setupBase(t);
    const cierreId = await crearCierreDummy(t, userId);
    await expect(
      t.run((ctx) => aplicarCierreImpl(ctx, { cierreTurnoId: cierreId, metrosBuenos: 10, caballetes105Pzas: -1, caballetes106Pzas: 0, consumoPorMaterial: [], createdBy: userId }))
    ).rejects.toThrow(/caballetes105Pzas no puede ser negativo/);
  });

  test('rechaza kgConsumido negativo', async () => {
    const t = convexTest(schema, modules);
    const { userId, matAId } = await setupBase(t);
    const cierreId = await crearCierreDummy(t, userId);
    await expect(
      t.run((ctx) =>
        aplicarCierreImpl(ctx, {
          cierreTurnoId: cierreId, metrosBuenos: 10, caballetes105Pzas: 0, caballetes106Pzas: 0,
          consumoPorMaterial: [{ materialId: matAId, kgConsumido: -5 }], createdBy: userId,
        })
      )
    ).rejects.toThrow(/kgConsumido no puede ser negativo/);
  });

  test('aplicar → revertir deja el estado materializado igual al inicial', async () => {
    const t = convexTest(schema, modules);
    const { userId, matAId } = await setupBase(t);
    const capaAId = await sembrarCapaMatA(t, matAId, userId, 200, 5);
    const cierreId = await crearCierreDummy(t, userId);

    const r1 = await t.run((ctx) =>
      aplicarCierreImpl(ctx, {
        cierreTurnoId: cierreId, metrosBuenos: 40, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }], createdBy: userId,
      })
    );
    expect(r1.kgBuenos).toBe(160); // 40 * 4
    expect(r1.mermaTotalKg).toBe(20); // 180 - 160
    expect(r1.trituradoKg).toBe(20); // toda la merma, sin caballetes
    expect(r1.costoTotalConsumido).toBe(180 * 5);

    const capaA_1 = await getCapa(t, capaAId);
    expect(capaA_1?.kgRestante).toBe(20); // 200 - 180

    await t.run((ctx) => revertirCierreImpl(ctx, { cierreTurnoId: cierreId, createdBy: userId }));

    const capaA_2 = await getCapa(t, capaAId);
    expect(capaA_2?.kgRestante).toBe(200); // vuelve al estado inicial
    expect(capaA_2?.agotada).toBe(false);

    const existenciaTriturado = await t.run(async (ctx) =>
      (await ctx.db.query('capasCosto').withIndex('by_cierreTurnoId_origen', (q: any) => q.eq('cierreTurnoId', cierreId).eq('origen', 'triturado')).collect())
        .reduce((s: number, c: any) => s + (c.agotada ? 0 : c.kgRestante), 0)
    );
    expect(existenciaTriturado).toBe(0); // el Triturado generado quedó voided
  });

  test('recierre (aplicar → revertir → aplicar con valores nuevos) da el mismo resultado que aplicar una sola vez', async () => {
    const t = convexTest(schema, modules);
    const { userId, matAId } = await setupBase(t);
    const capaAId = await sembrarCapaMatA(t, matAId, userId, 200, 5);
    const cierreId = await crearCierreDummy(t, userId);

    await t.run((ctx) =>
      aplicarCierreImpl(ctx, {
        cierreTurnoId: cierreId, metrosBuenos: 40, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }], createdBy: userId,
      })
    );
    await t.run((ctx) => revertirCierreImpl(ctx, { cierreTurnoId: cierreId, createdBy: userId }));
    const r2 = await t.run((ctx) =>
      aplicarCierreImpl(ctx, {
        cierreTurnoId: cierreId, metrosBuenos: 35, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 150 }], createdBy: userId,
      })
    );

    expect(r2.trituradoKg).toBe(10); // 150 - 140
    const capaA = await getCapa(t, capaAId);
    expect(capaA?.kgRestante).toBe(50); // 200 - 150, igual que si se hubiera aplicado una sola vez

    const capasTriturado = await t.run((ctx) =>
      ctx.db.query('capasCosto').withIndex('by_cierreTurnoId_origen', (q) => q.eq('cierreTurnoId', cierreId).eq('origen', 'triturado')).collect()
    );
    expect(capasTriturado.filter((c) => !c.agotada)).toHaveLength(1); // solo una activa
  });

  // EDS-71 (auditoría de PR2): revertirCierreImpl elegía "la capa de
  // Triturado más reciente" comparando `createdAt` (Date.now() propio de
  // la app) entre TODAS las capas del mismo cierreTurnoId — con 2+ capas
  // en la mesa (varias rondas de recaptura), un empate de milisegundo
  // podía elegir la equivocada. Este test deja 3 capas en la tabla (2 ya
  // voided de rondas anteriores + 1 viva) para las que la selección
  // ANTES dependía de comparar timestamps, y ahora se basa en cuál no
  // tiene `reversa_generacion` en su ledger — sin importar el orden de
  // inserción ni si dos quedaron con el mismo `createdAt`.
  test('EDS-71: con 3 rondas de recaptura (3 capas de Triturado, 2 ya voided), revertir la última elige la capa viva correcta', async () => {
    const t = convexTest(schema, modules);
    const { userId, matAId } = await setupBase(t);
    await sembrarCapaMatA(t, matAId, userId, 500, 5);
    const cierreId = await crearCierreDummy(t, userId);

    // Ronda 1
    await t.run((ctx) =>
      aplicarCierreImpl(ctx, {
        cierreTurnoId: cierreId, metrosBuenos: 40, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }], createdBy: userId,
      })
    );
    await t.run((ctx) => revertirCierreImpl(ctx, { cierreTurnoId: cierreId, createdBy: userId }));
    // Ronda 2
    await t.run((ctx) =>
      aplicarCierreImpl(ctx, {
        cierreTurnoId: cierreId, metrosBuenos: 35, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 150 }], createdBy: userId,
      })
    );
    await t.run((ctx) => revertirCierreImpl(ctx, { cierreTurnoId: cierreId, createdBy: userId }));
    // Ronda 3 (la que debe quedar viva al final)
    const r3 = await t.run((ctx) =>
      aplicarCierreImpl(ctx, {
        cierreTurnoId: cierreId, metrosBuenos: 30, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 130 }], createdBy: userId,
      })
    );
    expect(r3.trituradoKg).toBe(10); // 130 - 120

    // Ahora hay 3 capas de Triturado con el mismo cierreTurnoId: 2 voided
    // (rondas 1 y 2) + 1 viva (ronda 3). Revertir debe encontrar y voidear
    // EXACTAMENTE la de la ronda 3 — nunca lanzar el error de "más de una
    // capa viva" (probaría que la detección de vivas/voided es correcta).
    const capasAntes = await t.run((ctx) =>
      ctx.db.query('capasCosto').withIndex('by_cierreTurnoId_origen', (q) => q.eq('cierreTurnoId', cierreId).eq('origen', 'triturado')).collect()
    );
    expect(capasAntes).toHaveLength(3);
    expect(capasAntes.filter((c) => !c.agotada)).toHaveLength(1);

    await expect(
      t.run((ctx) => revertirCierreImpl(ctx, { cierreTurnoId: cierreId, createdBy: userId }))
    ).resolves.not.toThrow();

    const capasDespues = await t.run((ctx) =>
      ctx.db.query('capasCosto').withIndex('by_cierreTurnoId_origen', (q) => q.eq('cierreTurnoId', cierreId).eq('origen', 'triturado')).collect()
    );
    expect(capasDespues.filter((c) => !c.agotada)).toHaveLength(0); // las 3 quedaron voided, ninguna viva
    expect(capasDespues.every((c) => c.kgRestante === 0)).toBe(true);
  });

  test('bloquea revertir si el Triturado generado ya fue consumido PARCIALMENTE por un cierre posterior', async () => {
    const t = convexTest(schema, modules);
    const { userId, matAId, trituradoId } = await setupBase(t);
    await sembrarCapaMatA(t, matAId, userId, 200, 5);
    const cierre1 = await crearCierreDummy(t, userId);
    const cierre2 = await crearCierreDummy(t, userId);

    await t.run((ctx) =>
      aplicarCierreImpl(ctx, {
        cierreTurnoId: cierre1, metrosBuenos: 40, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }], createdBy: userId,
      })
    ); // genera 20kg de Triturado

    await t.run((ctx) =>
      aplicarCierreImpl(ctx, {
        cierreTurnoId: cierre2, metrosBuenos: 0, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: trituradoId, kgConsumido: 5 }], createdBy: userId,
      })
    ); // consume 5kg de esos 20kg

    await expect(t.run((ctx) => revertirCierreImpl(ctx, { cierreTurnoId: cierre1, createdBy: userId }))).rejects.toThrow(
      /consumidos \(netos\)/
    );
  });

  test('BUG REGRESIÓN: bloquea revertir si el Triturado generado fue consumido AL 100% (queda agotada:true)', async () => {
    const t = convexTest(schema, modules);
    const { userId, matAId, trituradoId } = await setupBase(t);
    await sembrarCapaMatA(t, matAId, userId, 200, 5);
    const cierre1 = await crearCierreDummy(t, userId);
    const cierre2 = await crearCierreDummy(t, userId);

    await t.run((ctx) =>
      aplicarCierreImpl(ctx, {
        cierreTurnoId: cierre1, metrosBuenos: 40, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }], createdBy: userId,
      })
    ); // genera 20kg de Triturado

    // Consume los 20kg COMPLETOS — la capa queda agotada:true por consumo,
    // no por reversa. Antes del fix, el filtro `!c.agotada` la volvía
    // invisible para revertirCierreImpl y el bloqueo de abajo NUNCA se
    // disparaba.
    await t.run((ctx) =>
      aplicarCierreImpl(ctx, {
        cierreTurnoId: cierre2, metrosBuenos: 0, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: trituradoId, kgConsumido: 20 }], createdBy: userId,
      })
    );

    const capaTrituradoDespues = await t.run((ctx) =>
      ctx.db.query('capasCosto').withIndex('by_cierreTurnoId_origen', (q) => q.eq('cierreTurnoId', cierre1).eq('origen', 'triturado')).collect()
    );
    expect(capaTrituradoDespues[0]?.agotada).toBe(true); // confirma la premisa del test

    await expect(t.run((ctx) => revertirCierreImpl(ctx, { cierreTurnoId: cierre1, createdBy: userId }))).rejects.toThrow(
      /consumidos \(netos\)/
    );
  });

  test('revertir es idempotente: llamarlo dos veces no duplica la reversa_generacion del Triturado', async () => {
    const t = convexTest(schema, modules);
    const { userId, matAId } = await setupBase(t);
    await sembrarCapaMatA(t, matAId, userId, 200, 5);
    const cierreId = await crearCierreDummy(t, userId);

    await t.run((ctx) =>
      aplicarCierreImpl(ctx, {
        cierreTurnoId: cierreId, metrosBuenos: 40, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }], createdBy: userId,
      })
    );
    await t.run((ctx) => revertirCierreImpl(ctx, { cierreTurnoId: cierreId, createdBy: userId }));
    await t.run((ctx) => revertirCierreImpl(ctx, { cierreTurnoId: cierreId, createdBy: userId })); // segunda vez, no debe tronar ni duplicar

    const capaTriturado = await t.run((ctx) =>
      ctx.db.query('capasCosto').withIndex('by_cierreTurnoId_origen', (q) => q.eq('cierreTurnoId', cierreId).eq('origen', 'triturado')).collect()
    );
    const movs = await getMovimientos(t, capaTriturado[0]._id);
    expect(movs.filter((m: any) => m.tipo === 'reversa_generacion')).toHaveLength(1); // no 2
  });
});
