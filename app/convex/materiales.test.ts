import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearMaterialPrueba, crearUsuarioPrueba, crearSesionPrueba, crearParametrosPrueba } from './testHelpers';

const modules = import.meta.glob('./**/*.ts');

async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
  await crearParametrosPrueba(t, 4); // cargasPorTurno:8, turnosPorDia:2
  const adminId = await crearUsuarioPrueba(t, 'admin');
  const compradorId = await crearUsuarioPrueba(t, 'compras');
  const adminToken = await crearSesionPrueba(t, adminId);
  const comprasToken = await crearSesionPrueba(t, compradorId);
  return { adminId, adminToken, comprasToken };
}

describe('materiales: listCatalogo (tarea 2.1)', () => {
  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(t.query(api.materiales.listCatalogo, { token: comprasToken })).rejects.toThrow();
  });

  test('%mezcla y consumo diario se derivan de formulaCarga/parametrosProduccion, no de un valor guardado', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matAId = await crearMaterialPrueba(t, { leadTimeDias: 0, stockSeguridadDias: 0 });
    const matBId = await crearMaterialPrueba(t, { leadTimeDias: 0, stockSeguridadDias: 0 });
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: matAId, kgPorCarga: 25, nota: '', updatedAt: Date.now() }));
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: matBId, kgPorCarga: 75, nota: '', updatedAt: Date.now() }));

    const catalogo = await t.query(api.materiales.listCatalogo, { token: adminToken });
    const filaA = catalogo.find((m) => m.materialId === matAId);
    const filaB = catalogo.find((m) => m.materialId === matBId);
    // total=100kg/carga → A=25%, B=75%
    expect(filaA?.formulaPct).toBeCloseTo(25, 5);
    expect(filaB?.formulaPct).toBeCloseTo(75, 5);
    // consumoDiario = kgPorCarga × cargasPorTurno(8) × turnosPorDia(2) × 2 líneas
    expect(filaA?.consumoDiario).toBeCloseTo(25 * 8 * 2 * 2, 5);
  });

  test('reorderCalc/reorderEnUso: modo auto usa el cálculo, modo manual usa el override', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const autoId = await crearMaterialPrueba(t, { leadTimeDias: 10, stockSeguridadDias: 7 });
    const manualId = await crearMaterialPrueba(t, { leadTimeDias: 10, stockSeguridadDias: 7, reorderMode: 'manual', reorderManualKg: 999999 });
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: autoId, kgPorCarga: 10, nota: '', updatedAt: Date.now() }));
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: manualId, kgPorCarga: 10, nota: '', updatedAt: Date.now() }));

    const catalogo = await t.query(api.materiales.listCatalogo, { token: adminToken });
    const filaAuto = catalogo.find((m) => m.materialId === autoId);
    const filaManual = catalogo.find((m) => m.materialId === manualId);
    const consumoEsperado = 10 * 8 * 2 * 2;
    expect(filaAuto?.reorderCalc).toBeCloseTo(consumoEsperado * (10 + 7), 5);
    expect(filaAuto?.reorderEnUso).toBe(filaAuto?.reorderCalc);
    expect(filaManual?.reorderCalc).toBeCloseTo(consumoEsperado * (10 + 7), 5); // se sigue calculando, solo no se usa
    expect(filaManual?.reorderEnUso).toBe(999999);
  });

  // EDS-88: lineasActivas — antes hardcoded a 2 (NUM_LINEAS), ahora
  // editable desde Catálogo. Confirma que consumoDiario/reorderCalc
  // responden al valor configurado, no al hardcode viejo.
  test('lineasActivas configurado a 1 reduce consumoDiario/reorderCalc a la mitad vs. el default de 2', async () => {
    const t = convexTest(schema, modules);
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);
    await crearParametrosPrueba(t, 4, 1); // lineasActivas:1 explícito
    const matId = await crearMaterialPrueba(t, { leadTimeDias: 0, stockSeguridadDias: 0 });
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: matId, kgPorCarga: 10, nota: '', updatedAt: Date.now() }));

    const catalogo = await t.query(api.materiales.listCatalogo, { token: adminToken });
    const fila = catalogo.find((m) => m.materialId === matId);
    // consumoDiario = 10 kgPorCarga × 8 cargasPorTurno × 2 turnosPorDia × 1 línea
    expect(fila?.consumoDiario).toBeCloseTo(10 * 8 * 2 * 1, 5);
  });

  test('Triturado (esInterno) y sustitutos (esSustituto) no tienen punto de reorden', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const trituradoId = await crearMaterialPrueba(t, { esInterno: true });
    const sustitutoId = await crearMaterialPrueba(t, { esSustituto: true });

    const catalogo = await t.query(api.materiales.listCatalogo, { token: adminToken });
    expect(catalogo.find((m) => m.materialId === trituradoId)?.reorderEnUso).toBeNull();
    expect(catalogo.find((m) => m.materialId === sustitutoId)?.reorderEnUso).toBeNull();
  });
});

describe('materiales: updateMaterial (tarea 2.1)', () => {
  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await expect(
      t.mutation(api.materiales.updateMaterial, { materialId: matId, costoEstandar: 20, token: comprasToken })
    ).rejects.toThrow();
  });

  test('admin puede editar costoEstandar y se refleja de inmediato en listCatalogo', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { costoEstandar: 10 });

    await t.mutation(api.materiales.updateMaterial, { materialId: matId, costoEstandar: 25.5, token: adminToken });
    const catalogo = await t.query(api.materiales.listCatalogo, { token: adminToken });
    expect(catalogo.find((m) => m.materialId === matId)?.costoEstandar).toBe(25.5);
  });

  test('BLOQUEADO: el costo de Triturado (esInterno) no se puede editar — siempre $0', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const trituradoId = await crearMaterialPrueba(t, { esInterno: true });
    await expect(
      t.mutation(api.materiales.updateMaterial, { materialId: trituradoId, costoEstandar: 5, token: adminToken })
    ).rejects.toThrow(/siempre es \$0/);
  });

  test('rechaza valores negativos', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await expect(
      t.mutation(api.materiales.updateMaterial, { materialId: matId, costoEstandar: -1, token: adminToken })
    ).rejects.toThrow(/negativo/);
    await expect(
      t.mutation(api.materiales.updateMaterial, { materialId: matId, cantidadPedirKg: -1, token: adminToken })
    ).rejects.toThrow(/negativo/);
  });
});

describe('materiales: guardarCatalogoCompleto es atómico', () => {
  test('guarda varios materiales en una sola transacción', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matAId = await crearMaterialPrueba(t, { costoEstandar: 1 });
    const matBId = await crearMaterialPrueba(t, { costoEstandar: 1 });

    await t.mutation(api.materiales.guardarCatalogoCompleto, {
      materiales: [{ materialId: matAId, costoEstandar: 11 }, { materialId: matBId, costoEstandar: 22 }],
      token: adminToken,
    });
    const catalogo = await t.query(api.materiales.listCatalogo, { token: adminToken });
    expect(catalogo.find((m) => m.materialId === matAId)?.costoEstandar).toBe(11);
    expect(catalogo.find((m) => m.materialId === matBId)?.costoEstandar).toBe(22);
  });

  test('BUG DE INTEGRIDAD REGRESIÓN: si un material del batch falla, NINGUNO queda guardado', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matAId = await crearMaterialPrueba(t, { costoEstandar: 1 });
    const trituradoId = await crearMaterialPrueba(t, { esInterno: true, costoEstandar: 0 });

    await expect(
      t.mutation(api.materiales.guardarCatalogoCompleto, {
        materiales: [{ materialId: matAId, costoEstandar: 99 }, { materialId: trituradoId, costoEstandar: 5 }],
        token: adminToken,
      })
    ).rejects.toThrow(/siempre es \$0/);

    const catalogo = await t.query(api.materiales.listCatalogo, { token: adminToken });
    expect(catalogo.find((m) => m.materialId === matAId)?.costoEstandar).toBe(1); // no quedó en 99
  });

  test('rechaza un batch vacío', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await expect(
      t.mutation(api.materiales.guardarCatalogoCompleto, { materiales: [], token: adminToken })
    ).rejects.toThrow(/al menos un material/);
  });

  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await expect(
      t.mutation(api.materiales.guardarCatalogoCompleto, { materiales: [{ materialId: matId, costoEstandar: 5 }], token: comprasToken })
    ).rejects.toThrow();
  });
});
