import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearMaterialPrueba, crearUsuarioPrueba, crearSesionPrueba, crearParametrosPrueba } from './testHelpers';

const modules = import.meta.glob('./**/*.ts');

async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
  await crearParametrosPrueba(t, 4);
  const adminId = await crearUsuarioPrueba(t, 'admin');
  const compradorId = await crearUsuarioPrueba(t, 'compras');
  const adminToken = await crearSesionPrueba(t, adminId);
  const comprasToken = await crearSesionPrueba(t, compradorId);
  return { adminId, adminToken, comprasToken };
}

describe('parametros: getParametros/updateParametros (tarea 2.2)', () => {
  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(t.query(api.parametros.getParametros, { token: comprasToken })).rejects.toThrow();
    await expect(
      t.mutation(api.parametros.updateParametros, { cargasPorTurno: 10, token: comprasToken })
    ).rejects.toThrow();
  });

  test('updateParametros persiste y getParametros lo refleja', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.mutation(api.parametros.updateParametros, { cargasPorTurno: 10, turnosPorDia: 2, token: adminToken });
    const params = await t.query(api.parametros.getParametros, { token: adminToken });
    expect(params.cargasPorTurno).toBe(10);
    expect(params.turnosPorDia).toBe(2);
  });

  test('rechaza cargasPorTurno negativo y kgPorMetro <= 0', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await expect(
      t.mutation(api.parametros.updateParametros, { cargasPorTurno: -1, token: adminToken })
    ).rejects.toThrow(/negativo/);
    await expect(
      t.mutation(api.parametros.updateParametros, { kgPorMetro: 0, token: adminToken })
    ).rejects.toThrow(/mayor a 0/);
  });
});

describe('parametros: updateFormulaCarga (tarea 2.2) — fuente única de verdad con Catálogo', () => {
  test('inserta la fórmula si el material todavía no tiene una fila', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await t.mutation(api.parametros.updateFormulaCarga, { materialId: matId, kgPorCarga: 30, nota: 'nueva', token: adminToken });
    const params = await t.query(api.parametros.getParametros, { token: adminToken });
    expect(params.formula.find((f) => f.materialId === matId)?.kgPorCarga).toBe(30);
  });

  test('actualiza (no duplica) si el material ya tiene una fila de fórmula', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: matId, kgPorCarga: 25, nota: '', updatedAt: Date.now() }));

    await t.mutation(api.parametros.updateFormulaCarga, { materialId: matId, kgPorCarga: 40, token: adminToken });

    const filas = await t.run((ctx) => ctx.db.query('formulaCarga').withIndex('by_materialId', (q) => q.eq('materialId', matId)).collect());
    expect(filas).toHaveLength(1);
    expect(filas[0].kgPorCarga).toBe(40);
  });

  test('INTEGRACIÓN: cambiar kgPorCarga aquí recalcula %mezcla y consumoDiario en listCatalogo, sin tocar materiales.ts', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matAId = await crearMaterialPrueba(t);
    const matBId = await crearMaterialPrueba(t);
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: matAId, kgPorCarga: 50, nota: '', updatedAt: Date.now() }));
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: matBId, kgPorCarga: 50, nota: '', updatedAt: Date.now() }));

    let catalogo = await t.query(api.materiales.listCatalogo, { token: adminToken });
    expect(catalogo.find((m) => m.materialId === matAId)?.formulaPct).toBeCloseTo(50, 5);

    // Cambia la fórmula de A a 90 (B sigue en 50) — total ahora 140.
    await t.mutation(api.parametros.updateFormulaCarga, { materialId: matAId, kgPorCarga: 90, token: adminToken });

    catalogo = await t.query(api.materiales.listCatalogo, { token: adminToken });
    const filaA = catalogo.find((m) => m.materialId === matAId);
    expect(filaA?.kgPorCarga).toBe(90);
    expect(filaA?.formulaPct).toBeCloseTo((90 / 140) * 100, 5);
  });

  test('INTEGRACIÓN: cambiar cargasPorTurno recalcula consumoDiario en listCatalogo de inmediato', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: matId, kgPorCarga: 20, nota: '', updatedAt: Date.now() }));

    const antes = await t.query(api.materiales.listCatalogo, { token: adminToken });
    expect(antes.find((m) => m.materialId === matId)?.consumoDiario).toBeCloseTo(20 * 8 * 2 * 2, 5);

    await t.mutation(api.parametros.updateParametros, { cargasPorTurno: 16, token: adminToken });

    const despues = await t.query(api.materiales.listCatalogo, { token: adminToken });
    expect(despues.find((m) => m.materialId === matId)?.consumoDiario).toBeCloseTo(20 * 16 * 2 * 2, 5);
  });

  test('rechaza kgPorCarga negativo', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await expect(
      t.mutation(api.parametros.updateFormulaCarga, { materialId: matId, kgPorCarga: -5, token: adminToken })
    ).rejects.toThrow(/negativo/);
  });

  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await expect(
      t.mutation(api.parametros.updateFormulaCarga, { materialId: matId, kgPorCarga: 10, token: comprasToken })
    ).rejects.toThrow();
  });
});

describe('parametros: guardarParametrosCompleto es atómico', () => {
  test('guarda cargasPorTurno + toda la fórmula en una sola transacción', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matAId = await crearMaterialPrueba(t);
    const matBId = await crearMaterialPrueba(t);

    await t.mutation(api.parametros.guardarParametrosCompleto, {
      cargasPorTurno: 12, turnosPorDia: 2, kgPorMetro: 4.5,
      formula: [{ materialId: matAId, kgPorCarga: 30 }, { materialId: matBId, kgPorCarga: 70 }],
      token: adminToken,
    });

    const params = await t.query(api.parametros.getParametros, { token: adminToken });
    expect(params.cargasPorTurno).toBe(12);
    expect(params.kgPorMetro).toBe(4.5);
    expect(params.formula.find((f) => f.materialId === matAId)?.kgPorCarga).toBe(30);
    expect(params.formula.find((f) => f.materialId === matBId)?.kgPorCarga).toBe(70);
  });

  test('BUG DE INTEGRIDAD REGRESIÓN: si un material de la fórmula falla, NADA del batch queda guardado (ni cargasPorTurno)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matAId = await crearMaterialPrueba(t);

    await expect(
      t.mutation(api.parametros.guardarParametrosCompleto, {
        cargasPorTurno: 99, turnosPorDia: 2, kgPorMetro: 4,
        formula: [{ materialId: matAId, kgPorCarga: 20 }, { materialId: matAId, kgPorCarga: -5 }],
        token: adminToken,
      })
    ).rejects.toThrow(/negativo/);

    const params = await t.query(api.parametros.getParametros, { token: adminToken });
    expect(params.cargasPorTurno).toBe(8); // no quedó en 99 — el default de crearParametrosPrueba
  });

  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(
      t.mutation(api.parametros.guardarParametrosCompleto, { cargasPorTurno: 1, turnosPorDia: 1, kgPorMetro: 1, formula: [], token: comprasToken })
    ).rejects.toThrow();
  });
});
