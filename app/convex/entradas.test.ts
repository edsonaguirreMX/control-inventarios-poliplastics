import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearMaterialPrueba, crearUsuarioPrueba, crearSesionPrueba, crearParametrosPrueba, crearRolesPrueba } from './testHelpers';
import { fechaOperativa, sumarDiasISO } from './lib/fechaOperativa';

const modules = import.meta.glob('./**/*.ts');

async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
  await crearRolesPrueba(t); // EDS-105: requireAcceso resuelve el rol contra la tabla `roles`
  await crearParametrosPrueba(t); // EDS-83: crearEntrada(sBatch) ahora valida fecha contra parametrosProduccion
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
    await crearRolesPrueba(t); // EDS-105
    await crearParametrosPrueba(t);
    const matInactivoId = await crearMaterialPrueba(t, { activo: false });
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);

    await expect(
      t.mutation(api.entradas.crearEntrada, { fecha: '2026-08-08', materialId: matInactivoId, cantidadKg: 100, token: adminToken })
    ).rejects.toThrow(/no está activo/);
  });

  test('rechaza crear entrada con material interno (Triturado no se compra)', async () => {
    const t = convexTest(schema, modules);
    await crearRolesPrueba(t); // EDS-105
    await crearParametrosPrueba(t);
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

describe('entradas: crearEntradasBatch es atómico (No-Go de auditoría de PR 3, mayor #3)', () => {
  test('crea todas las entradas del batch en una sola transacción', async () => {
    const t = convexTest(schema, modules);
    const { matId, operadorToken } = await setup(t);
    const matB = await crearMaterialPrueba(t, { esInterno: false, activo: true });

    const ids = await t.mutation(api.entradas.crearEntradasBatch, {
      fecha: '2026-08-08',
      materiales: [{ materialId: matId, cantidadKg: 100 }, { materialId: matB, cantidadKg: 250 }],
      token: operadorToken,
    });
    expect(ids).toHaveLength(2);
    const entradas = await t.run((ctx) => ctx.db.query('entradas').collect());
    expect(entradas).toHaveLength(2);
  });

  test('BUG DE INTEGRIDAD REGRESIÓN: si un material del batch falla, NINGUNA entrada del batch queda guardada (sin guardado parcial)', async () => {
    const t = convexTest(schema, modules);
    const { matId, operadorToken } = await setup(t);
    const matInactivo = await crearMaterialPrueba(t, { activo: false });

    // El primer material es válido, el segundo (inactivo) debe hacer
    // fallar la mutation ENTERA — antes (loop de mutations independientes
    // desde el cliente) el primero habría quedado guardado igual.
    await expect(
      t.mutation(api.entradas.crearEntradasBatch, {
        fecha: '2026-08-08',
        materiales: [{ materialId: matId, cantidadKg: 100 }, { materialId: matInactivo, cantidadKg: 50 }],
        token: operadorToken,
      })
    ).rejects.toThrow(/no está activo/);

    const entradas = await t.run((ctx) => ctx.db.query('entradas').collect());
    expect(entradas).toHaveLength(0); // ni siquiera el material válido quedó guardado
  });

  test('rechaza un batch vacío', async () => {
    const t = convexTest(schema, modules);
    const { operadorToken } = await setup(t);
    await expect(
      t.mutation(api.entradas.crearEntradasBatch, { fecha: '2026-08-08', materiales: [], token: operadorToken })
    ).rejects.toThrow(/al menos un material/);
  });

  test('un operador no puede colar costoUnitario vía el batch (mismo bloqueo que crearEntrada individual)', async () => {
    const t = convexTest(schema, modules);
    const { matId, adminToken } = await setup(t);
    // crearEntradasBatch no acepta costoUnitario en su schema de args —
    // esto es una prueba de contrato: el batch del operador solo puede
    // crear entradas pendientes, nunca costeadas, ni siquiera con admin.
    const ids = await t.mutation(api.entradas.crearEntradasBatch, {
      fecha: '2026-08-08', materiales: [{ materialId: matId, cantidadKg: 100 }], token: adminToken,
    });
    const entrada = await t.run((ctx) => ctx.db.get(ids[0]));
    expect(entrada?.estado).toBe('pendiente');
    expect(entrada?.capaId).toBeNull();
  });
});

// EDS-83: a diferencia de un cierre de turno, SÍ es normal registrar
// tarde el papeleo de una entrada real vieja (caso ya cubierto arriba:
// "la capa creada usa la fecha REAL de la entrada" usa fecha 2020-01-15
// sin problema) — pero una fecha futura nunca tiene sentido para ningún
// caso, así que sí se rechaza igual que en cierres.
describe('entradas: valida fecha en servidor, sin límite hacia atrás (EDS-83)', () => {
  test('rechaza una fecha futura', async () => {
    const t = convexTest(schema, modules);
    const { matId, adminToken } = await setup(t);
    const manana = sumarDiasISO(fechaOperativa(Date.now(), 'America/Mexico_City', '06:00'), 1);

    await expect(
      t.mutation(api.entradas.crearEntrada, { fecha: manana, materialId: matId, cantidadKg: 100, token: adminToken })
    ).rejects.toThrow(/fecha futura/);

    expect(await t.run((ctx) => ctx.db.query('entradas').collect())).toHaveLength(0);
  });

  test('crearEntradasBatch también rechaza una fecha futura', async () => {
    const t = convexTest(schema, modules);
    const { matId, adminToken } = await setup(t);
    const manana = sumarDiasISO(fechaOperativa(Date.now(), 'America/Mexico_City', '06:00'), 1);

    await expect(
      t.mutation(api.entradas.crearEntradasBatch, {
        fecha: manana, materiales: [{ materialId: matId, cantidadKg: 100 }], token: adminToken,
      })
    ).rejects.toThrow(/fecha futura/);
  });
});
