import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearMaterialPrueba, crearUsuarioPrueba, crearSesionPrueba } from './testHelpers';

const modules = import.meta.glob('./**/*.ts');

async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
  const matId = await crearMaterialPrueba(t, { esInterno: false, activo: true });
  const operadorId = await crearUsuarioPrueba(t, 'operador');
  const adminId = await crearUsuarioPrueba(t, 'admin');
  const operadorToken = await crearSesionPrueba(t, operadorId);
  const adminToken = await crearSesionPrueba(t, adminId);
  return { matId, operadorToken, adminToken };
}

describe('entradas: backend de Entradas (tarea 3.3, endurecido en auditoría)', () => {
  test('operador puede crear entrada SIN costo (queda pendiente, sin capa)', async () => {
    const t = convexTest(schema, modules);
    const { matId, operadorToken } = await setup(t);

    const entradaId = await t.mutation(api.entradas.crearEntrada, {
      fecha: '2026-08-08', materialId: matId, cantidadKg: 100, token: operadorToken,
    });
    const entrada = await t.run((ctx) => ctx.db.get(entradaId));
    expect(entrada?.estado).toBe('pendiente');
    expect(entrada?.capaId).toBeNull();
  });

  test('BUG REGRESIÓN: operador NO puede crear entrada CON costo (crearía capa con costo arbitrario)', async () => {
    const t = convexTest(schema, modules);
    const { matId, operadorToken } = await setup(t);

    await expect(
      t.mutation(api.entradas.crearEntrada, {
        fecha: '2026-08-08', materialId: matId, cantidadKg: 100, costoUnitario: 999, token: operadorToken,
      })
    ).rejects.toThrow(/no puede capturar el costo/);

    const entradas = await t.run((ctx) => ctx.db.query('entradas').collect());
    expect(entradas).toHaveLength(0); // no se creó nada
  });

  test('admin SÍ puede crear entrada con costo (queda costeada, con capa)', async () => {
    const t = convexTest(schema, modules);
    const { matId, adminToken } = await setup(t);

    const entradaId = await t.mutation(api.entradas.crearEntrada, {
      fecha: '2026-08-08', materialId: matId, cantidadKg: 100, costoUnitario: 8, token: adminToken,
    });
    const entrada = await t.run((ctx) => ctx.db.get(entradaId));
    expect(entrada?.estado).toBe('costeada');
    expect(entrada?.capaId).not.toBeNull();
  });

  test('la capa creada usa la fecha REAL de la entrada, no "ahora"', async () => {
    const t = convexTest(schema, modules);
    const { matId, adminToken } = await setup(t);

    const entradaId = await t.mutation(api.entradas.crearEntrada, {
      fecha: '2020-01-15', materialId: matId, cantidadKg: 100, costoUnitario: 8, token: adminToken,
    });
    const entrada = await t.run((ctx) => ctx.db.get(entradaId));
    const capa = await t.run((ctx) => ctx.db.get(entrada!.capaId!));
    expect(capa?.fechaEntrada).toBe(Date.parse('2020-01-15T00:00:00Z'));
  });

  test('operador NO puede costear una entrada pendiente (costearEntrada exige compras/admin)', async () => {
    const t = convexTest(schema, modules);
    const { matId, operadorToken } = await setup(t);
    const entradaId = await t.mutation(api.entradas.crearEntrada, {
      fecha: '2026-08-08', materialId: matId, cantidadKg: 100, token: operadorToken,
    });

    await expect(
      t.mutation(api.entradas.costearEntrada, { entradaId, costoUnitario: 9, token: operadorToken })
    ).rejects.toThrow();
  });

  test('costear una entrada ya costeada falla (usar Corrección de Capturas)', async () => {
    const t = convexTest(schema, modules);
    const { matId, adminToken } = await setup(t);
    const entradaId = await t.mutation(api.entradas.crearEntrada, {
      fecha: '2026-08-08', materialId: matId, cantidadKg: 100, costoUnitario: 8, token: adminToken,
    });

    await expect(
      t.mutation(api.entradas.costearEntrada, { entradaId, costoUnitario: 20, token: adminToken })
    ).rejects.toThrow(/ya fue costeada/);
  });

  test('rechaza crear entrada con material inactivo', async () => {
    const t = convexTest(schema, modules);
    const matInactivoId = await crearMaterialPrueba(t, { activo: false });
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);

    await expect(
      t.mutation(api.entradas.crearEntrada, { fecha: '2026-08-08', materialId: matInactivoId, cantidadKg: 100, token: adminToken })
    ).rejects.toThrow(/no está activo/);
  });

  test('rechaza crear entrada con material interno (Triturado no se compra)', async () => {
    const t = convexTest(schema, modules);
    const trituradoId = await crearMaterialPrueba(t, { esInterno: true });
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);

    await expect(
      t.mutation(api.entradas.crearEntrada, { fecha: '2026-08-08', materialId: trituradoId, cantidadKg: 100, token: adminToken })
    ).rejects.toThrow(/se genera internamente/);
  });

  test('listEntradas y listCapasVigentes rechazan a operador (datos financieros)', async () => {
    const t = convexTest(schema, modules);
    const { operadorToken } = await setup(t);

    await expect(t.query(api.entradas.listEntradas, { token: operadorToken })).rejects.toThrow();
    await expect(t.query(api.entradas.listCapasVigentes, { token: operadorToken })).rejects.toThrow();
  });

  test('listMaterialesActivos SÍ es accesible para operador (sin datos de costo)', async () => {
    const t = convexTest(schema, modules);
    const { operadorToken } = await setup(t);
    const materiales = await t.query(api.entradas.listMaterialesActivos, { token: operadorToken });
    expect(Array.isArray(materiales)).toBe(true);
  });
});
