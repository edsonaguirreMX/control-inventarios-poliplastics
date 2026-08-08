import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearMaterialPrueba, crearUsuarioPrueba, crearSesionPrueba, crearParametrosPrueba } from './testHelpers';

const modules = import.meta.glob('./**/*.ts');

async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
  await crearParametrosPrueba(t, 4);
  await crearMaterialPrueba(t, { slug: 'triturado', esInterno: true });
  const matAId = await crearMaterialPrueba(t, { esInterno: false });
  const adminId = await crearUsuarioPrueba(t, 'admin');
  const compradorId = await crearUsuarioPrueba(t, 'compras');
  const operadorId = await crearUsuarioPrueba(t, 'operador');
  const adminToken = await crearSesionPrueba(t, adminId);
  const comprasToken = await crearSesionPrueba(t, compradorId);
  const operadorToken = await crearSesionPrueba(t, operadorId);

  // Capa inicial suficiente para los cierres de prueba.
  await t.mutation(api.entradas.crearEntrada, {
    fecha: '2026-08-01', materialId: matAId, cantidadKg: 500, costoUnitario: 5, token: adminToken,
  });

  return { matAId, adminToken, comprasToken, operadorToken };
}

describe('correcciones: actualizarCierreTurno usa el motor compartido (tarea 5.2)', () => {
  test('corrección deja auditoría con snapshot antes/después y no duplica consumo', async () => {
    const t = convexTest(schema, modules);
    const { matAId, adminToken, operadorToken } = await setup(t);

    const { cierreTurnoId } = await t.mutation(api.cierres.crearCierreTurno, {
      fecha: '2026-08-08', linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }],
      token: operadorToken,
    });

    const r = await t.mutation(api.correcciones.actualizarCierreTurno, {
      cierreTurnoId, cargasPreparadas: 8, metrosBuenos: 35, caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 150 }],
      nota: 'Metros mal capturados, se corrige.', token: adminToken,
    });
    expect(r.ok).toBe(true);

    const capaA = await t.run((ctx) => ctx.db.query('capasCosto').withIndex('by_material_fecha', (q) => q.eq('materialId', matAId)).first());
    expect(capaA?.kgRestante).toBe(350); // 500 - 150, no 500-180-150

    const cierre = await t.run((ctx) => ctx.db.get(cierreTurnoId));
    expect(cierre?.editado).toBe(true);
    expect(cierre?.vecesRecapturado).toBe(1);

    const historial = await t.run((ctx) => ctx.db.query('correccionesHistorial').withIndex('by_entidadId', (q) => q.eq('entidadId', String(cierreTurnoId))).collect());
    expect(historial).toHaveLength(1);
    expect(historial[0].motivo).toBe('correccion_manual');
    expect(historial[0].nota).toBe('Metros mal capturados, se corrige.');
    expect(JSON.parse(historial[0].snapshotAntes).metrosBuenos).toBe(40);
    expect(JSON.parse(historial[0].snapshotDespues).metrosBuenos).toBe(35);
  });

  test('operador NO puede corregir (solo admin)', async () => {
    const t = convexTest(schema, modules);
    const { matAId, operadorToken } = await setup(t);
    const { cierreTurnoId } = await t.mutation(api.cierres.crearCierreTurno, {
      fecha: '2026-08-08', linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }],
      token: operadorToken,
    });
    await expect(
      t.mutation(api.correcciones.actualizarCierreTurno, {
        cierreTurnoId, cargasPreparadas: 8, metrosBuenos: 35, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 150 }], token: operadorToken,
      })
    ).rejects.toThrow();
  });

  test('BLOQUEADO: corregir un cierre cuyo Triturado ya fue consumido por un cierre posterior', async () => {
    const t = convexTest(schema, modules);
    const { matAId, adminToken, operadorToken } = await setup(t);
    const trituradoId = await t.run((ctx) => ctx.db.query('materiales').withIndex('by_slug', (q) => q.eq('slug', 'triturado')).unique()).then((m) => m!._id);

    const { cierreTurnoId: cierre1 } = await t.mutation(api.cierres.crearCierreTurno, {
      fecha: '2026-08-08', linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }], // genera 20kg de Triturado
      token: operadorToken,
    });
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: '2026-08-08', linea: 2, turno: 1, cargasPreparadas: 0, metrosBuenos: 0,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: trituradoId, kgConsumido: 5 }], // consume 5kg de ese Triturado
      token: operadorToken,
    });

    await expect(
      t.mutation(api.correcciones.actualizarCierreTurno, {
        cierreTurnoId: cierre1, cargasPreparadas: 8, metrosBuenos: 35, caballetes105Pzas: 0, caballetes106Pzas: 0,
        consumoPorMaterial: [{ materialId: matAId, kgConsumido: 150 }], token: adminToken,
      })
    ).rejects.toThrow(/consumidos \(netos\)/);
  });
});

describe('correcciones: actualizarEntrada (tarea 5.3)', () => {
  test('entrada pendiente (sin capa): ajuste directo, sin lógica PEPS', async () => {
    const t = convexTest(schema, modules);
    const { matAId, comprasToken } = await setup(t);
    const entradaId = await t.mutation(api.entradas.crearEntrada, {
      fecha: '2026-08-08', materialId: matAId, cantidadKg: 100, token: comprasToken,
    });

    await t.mutation(api.correcciones.actualizarEntrada, { entradaId, cantidadKg: 150, token: comprasToken });
    const entrada = await t.run((ctx) => ctx.db.get(entradaId));
    expect(entrada?.cantidadKg).toBe(150);
    expect(entrada?.editado).toBe(true);
  });

  test('entrada costeada: aumentar cantidad ajusta la capa con ajuste_incremento', async () => {
    const t = convexTest(schema, modules);
    const { matAId, adminToken } = await setup(t);
    const entradaId = await t.mutation(api.entradas.crearEntrada, {
      fecha: '2026-08-08', materialId: matAId, cantidadKg: 100, costoUnitario: 8, token: adminToken,
    });
    const entrada = await t.run((ctx) => ctx.db.get(entradaId));

    await t.mutation(api.correcciones.actualizarEntrada, { entradaId, cantidadKg: 130, token: adminToken });

    const capa = await t.run((ctx) => ctx.db.get(entrada!.capaId!));
    expect(capa?.kgOriginal).toBe(130);
    expect(capa?.kgRestante).toBe(130); // nada se había consumido

    const movs = await t.run((ctx) => ctx.db.query('capaMovimientos').withIndex('by_capaId', (q) => q.eq('capaId', entrada!.capaId!)).collect());
    expect(movs.some((m) => m.tipo === 'ajuste_incremento' && m.kg === 30)).toBe(true);
  });

  test('BLOQUEADO: reducir por debajo de lo ya consumido de esa capa', async () => {
    const t = convexTest(schema, modules);
    const { matAId, adminToken, operadorToken } = await setup(t);
    // Entrada de 100kg costeada, y un cierre que consume 60kg de ELLA
    // (la capa de la entrada de 500kg del setup ya tiene fechaEntrada más
    // antigua, así que para forzar que el cierre consuma justo la capa de
    // esta entrada, la costeamos con una fecha aún más antigua).
    const entradaId = await t.mutation(api.entradas.crearEntrada, {
      fecha: '2025-01-01', materialId: matAId, cantidadKg: 100, costoUnitario: 8, token: adminToken,
    });
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: '2026-08-08', linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 0,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 60 }], // toma de la capa más antigua primero (esta)
      token: operadorToken,
    });

    await expect(
      t.mutation(api.correcciones.actualizarEntrada, { entradaId, cantidadKg: 50, token: adminToken })
    ).rejects.toThrow(/ya se consumieron/);
  });

  test('operador NO puede corregir entradas (solo compras/admin)', async () => {
    const t = convexTest(schema, modules);
    const { matAId, comprasToken, operadorToken } = await setup(t);
    const entradaId = await t.mutation(api.entradas.crearEntrada, {
      fecha: '2026-08-08', materialId: matAId, cantidadKg: 100, token: comprasToken,
    });
    await expect(
      t.mutation(api.correcciones.actualizarEntrada, { entradaId, cantidadKg: 150, token: operadorToken })
    ).rejects.toThrow();
  });
});

describe('correcciones: queries de lectura (tarea 5.1)', () => {
  test('listRegistrosUltimos10Dias marca el día de hoy si hay un cierre', async () => {
    const t = convexTest(schema, modules);
    const { matAId, adminToken, operadorToken } = await setup(t);
    const hoy = new Date().toISOString().slice(0, 10);
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: hoy, linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 10 }], token: operadorToken,
    });
    const dias = await t.query(api.correcciones.listRegistrosUltimos10Dias, { tipo: 'cierre', token: adminToken });
    expect(dias).toHaveLength(10);
    expect(dias.find((d) => d.fecha === hoy)?.tieneRegistro).toBe(true);
  });

  test('getCierre devuelve el cierre + sus consumos vigentes', async () => {
    const t = convexTest(schema, modules);
    const { matAId, adminToken, operadorToken } = await setup(t);
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: '2026-08-08', linea: 1, turno: 1, cargasPreparadas: 8, metrosBuenos: 40,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matAId, kgConsumido: 180 }], token: operadorToken,
    });
    const resultado = await t.query(api.correcciones.getCierre, { fecha: '2026-08-08', linea: 1, turno: 1, token: adminToken });
    expect(resultado?.cierre.metrosBuenos).toBe(40);
    expect(resultado?.consumos).toHaveLength(1);
  });

  test('compras (rol no permitido) no puede leer correcciones — solo admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(t.query(api.correcciones.getEntradasDelDia, { fecha: '2026-08-08', token: comprasToken })).rejects.toThrow();
  });
});
