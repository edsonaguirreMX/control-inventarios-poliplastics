import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import {
  crearMaterialPrueba,
  crearUsuarioPrueba,
  crearSesionPrueba,
  crearParametrosPrueba,
  crearRolesPrueba,
  getCapa,
} from './testHelpers';

// Inserta parametrosProduccion con una zonaHoraria arbitraria (distinta de
// la real de la planta, America/Mexico_City, que NO tiene horario de
// verano desde 2022) — necesario para poder ejercitar de verdad los casos
// de cambio de horario: no hay forma de provocar un hueco/ambigüedad real
// en America/Mexico_City hoy, pero la mutation acepta cualquier
// zonaHoraria que traiga parametrosProduccion, así que la validación debe
// funcionar en general, no solo para la zona que usa esta planta.
async function crearParametrosPruebaConZona(t: Awaited<ReturnType<typeof convexTest>>, zonaHoraria: string) {
  return t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert('parametrosProduccion', {
      cargasPorTurno: 8, turnosPorDia: 2, kgPorMetro: 4,
      horaInicioTurno1: '06:00', horaInicioTurno2: '18:00',
      diasLaborales: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
      minutosGraciaCierre: 60, zonaHoraria, updatedAt: now, updatedBy: null,
    });
  });
}

const modules = import.meta.glob('./**/*.ts');

describe('importacionInicial: importarInventarioInicial (EDS-41 / tarea 3.5)', () => {
  async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
    await crearRolesPrueba(t); // EDS-105: requireAcceso resuelve el rol contra la tabla `roles`
    await crearParametrosPrueba(t);
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const operadorId = await crearUsuarioPrueba(t, 'operador');
    const comprasId = await crearUsuarioPrueba(t, 'compras');
    const adminToken = await crearSesionPrueba(t, adminId);
    const operadorToken = await crearSesionPrueba(t, operadorId);
    const comprasToken = await crearSesionPrueba(t, comprasId);
    return { adminId, adminToken, operadorToken, comprasToken };
  }

  test('corriéndola una vez deja las existencias iniciales visibles y correctas', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const hdpeId = await crearMaterialPrueba(t, { slug: 'hdpe-r-pel', nombre: 'HDPE reciclado', esInterno: false });
    const trituradoId = await crearMaterialPrueba(t, { slug: 'triturado', nombre: 'Triturado', esInterno: true });

    const resultado = await t.mutation(api.importacionInicial.importarInventarioInicial, {
      fechaISO: '2026-08-10',
      horaCorte: '06:00',
      materiales: [
        { materialId: hdpeId, kgOriginal: 30775, costoUnitario: 28.5 },
        { materialId: trituradoId, kgOriginal: 1000, costoUnitario: 0 },
      ],
      token: adminToken,
    });

    expect(resultado.ok).toBe(true);
    expect(resultado.capaIds).toHaveLength(2);

    const existenciaHdpe = await t.query(api.peps.existenciaMaterial, { materialId: hdpeId, token: adminToken });
    expect(existenciaHdpe).toBe(30775);
    const existenciaTriturado = await t.query(api.peps.existenciaMaterial, { materialId: trituradoId, token: adminToken });
    expect(existenciaTriturado).toBe(1000);

    const valorHdpe = await t.query(api.peps.valorInventarioMaterial, { materialId: hdpeId, token: adminToken });
    expect(valorHdpe).toBe(30775 * 28.5);
    const valorTriturado = await t.query(api.peps.valorInventarioMaterial, { materialId: trituradoId, token: adminToken });
    expect(valorTriturado).toBe(0); // confirma que el costo $0 forzado también llega a la valuación, no solo al kg

    for (const capaId of resultado.capaIds) {
      const capa = await getCapa(t, capaId);
      expect(capa?.origen).toBe('inventarioInicial');
      expect(capa?.entradaId).toBeNull();
      expect(capa?.cierreTurnoId).toBeNull();
    }
  });

  test('acepta 0 kg (material sin existencia física al arranque, p. ej. HDPE virgen)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { slug: 'hdpe-v-pel', esInterno: false });

    const resultado = await t.mutation(api.importacionInicial.importarInventarioInicial, {
      fechaISO: '2026-08-10',
      horaCorte: '06:00',
      materiales: [{ materialId: matId, kgOriginal: 0, costoUnitario: 30 }],
      token: adminToken,
    });

    expect(resultado.ok).toBe(true);
    const capa = await getCapa(t, resultado.capaIds[0]);
    expect(capa?.kgOriginal).toBe(0);
    expect(capa?.agotada).toBe(true);
  });

  test('correrla dos veces para el mismo material falla explícitamente', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { esInterno: false });

    await t.mutation(api.importacionInicial.importarInventarioInicial, {
      fechaISO: '2026-08-10',
      horaCorte: '06:00',
      materiales: [{ materialId: matId, kgOriginal: 100, costoUnitario: 10 }],
      token: adminToken,
    });

    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-08-10',
        horaCorte: '06:00',
        materiales: [{ materialId: matId, kgOriginal: 50, costoUnitario: 12 }],
        token: adminToken,
      })
    ).rejects.toThrow(/ya tiene un inventario inicial importado/);

    // No debe haber quedado una segunda capa ni haberse alterado la primera.
    const existencia = await t.query(api.peps.existenciaMaterial, { materialId: matId, token: adminToken });
    expect(existencia).toBe(100);
  });

  test('atómica: si un material del lote falla su validación, NINGUNA capa del lote se crea', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matOk = await crearMaterialPrueba(t, { esInterno: false });
    const matYaImportado = await crearMaterialPrueba(t, { esInterno: false });

    // Preexistente: matYaImportado ya tiene su capa de arranque.
    await t.mutation(api.importacionInicial.importarInventarioInicial, {
      fechaISO: '2026-08-10',
      horaCorte: '06:00',
      materiales: [{ materialId: matYaImportado, kgOriginal: 10, costoUnitario: 1 }],
      token: adminToken,
    });

    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-08-10',
        horaCorte: '06:00',
        materiales: [
          { materialId: matOk, kgOriginal: 500, costoUnitario: 5 },
          { materialId: matYaImportado, kgOriginal: 10, costoUnitario: 1 },
        ],
        token: adminToken,
      })
    ).rejects.toThrow(/ya tiene un inventario inicial importado/);

    // matOk NO debe tener ninguna capa — el lote entero se descartó.
    const existenciaOk = await t.query(api.peps.existenciaMaterial, { materialId: matOk, token: adminToken });
    expect(existenciaOk).toBe(0);
  });

  test('fuerza costo $0 en cualquier material interno (esInterno) — rechaza costo distinto de 0', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const materialInternoId = await crearMaterialPrueba(t, { esInterno: true });

    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-08-10',
        horaCorte: '06:00',
        materiales: [{ materialId: materialInternoId, kgOriginal: 1000, costoUnitario: 5 }],
        token: adminToken,
      })
    ).rejects.toThrow(/siempre es \$0/);

    const existencia = await t.query(api.peps.existenciaMaterial, { materialId: materialInternoId, token: adminToken });
    expect(existencia).toBe(0);
  });

  test('rechaza materiales repetidos en el mismo lote', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { esInterno: false });

    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-08-10',
        horaCorte: '06:00',
        materiales: [
          { materialId: matId, kgOriginal: 100, costoUnitario: 10 },
          { materialId: matId, kgOriginal: 200, costoUnitario: 20 },
        ],
        token: adminToken,
      })
    ).rejects.toThrow(/repetido/);
  });

  test('rechaza kg o costo negativos', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { esInterno: false });

    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-08-10',
        horaCorte: '06:00',
        materiales: [{ materialId: matId, kgOriginal: -5, costoUnitario: 10 }],
        token: adminToken,
      })
    ).rejects.toThrow(/no pueden ser negativos/);

    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-08-10',
        horaCorte: '06:00',
        materiales: [{ materialId: matId, kgOriginal: 5, costoUnitario: -1 }],
        token: adminToken,
      })
    ).rejects.toThrow(/no puede ser negativo/);
  });

  test('rechaza fechaISO que no es una fecha calendario real (2026-02-30)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { esInterno: false });

    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-02-30',
        horaCorte: '06:00',
        materiales: [{ materialId: matId, kgOriginal: 100, costoUnitario: 10 }],
        token: adminToken,
      })
    ).rejects.toThrow(/no es una fecha calendario válida/);
  });

  test('rechaza horaCorte fuera de rango (25:00)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { esInterno: false });

    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-08-10',
        horaCorte: '25:00',
        materiales: [{ materialId: matId, kgOriginal: 100, costoUnitario: 10 }],
        token: adminToken,
      })
    ).rejects.toThrow(/fuera de rango/);
  });

  test('exige horaCorte en formato fijo HH:MM — rechaza "6:00" (hora sin ceros)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { esInterno: false });

    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-08-10',
        horaCorte: '6:00',
        materiales: [{ materialId: matId, kgOriginal: 100, costoUnitario: 10 }],
        token: adminToken,
      })
    ).rejects.toThrow(/se espera formato HH:MM/);
  });

  test('rechaza lote vacío', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);

    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-08-10',
        horaCorte: '06:00',
        materiales: [],
        token: adminToken,
      })
    ).rejects.toThrow(/al menos un material/);
  });

  test('autorización: un operador (rol no permitido) es rechazado, con el mensaje de autorización, y no crea capa', async () => {
    const t = convexTest(schema, modules);
    const { adminToken, operadorToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { esInterno: false });

    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-08-10',
        horaCorte: '06:00',
        materiales: [{ materialId: matId, kgOriginal: 100, costoUnitario: 10 }],
        token: operadorToken,
      })
    ).rejects.toThrow(/No autorizado/);

    const existencia = await t.query(api.peps.existenciaMaterial, { materialId: matId, token: adminToken });
    expect(existencia).toBe(0);
  });

  test('autorización: compras (rol no permitido — esta operación es admin-only) es rechazado', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { esInterno: false });

    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-08-10',
        horaCorte: '06:00',
        materiales: [{ materialId: matId, kgOriginal: 100, costoUnitario: 10 }],
        token: comprasToken,
      })
    ).rejects.toThrow(/No autorizado/);
  });

  test('la fechaEntrada resultante respeta la hora local (zonaHoraria de parametrosProduccion)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { esInterno: false });

    const resultado = await t.mutation(api.importacionInicial.importarInventarioInicial, {
      fechaISO: '2026-08-10',
      horaCorte: '06:00',
      materiales: [{ materialId: matId, kgOriginal: 100, costoUnitario: 10 }],
      token: adminToken,
    });

    const capa = await getCapa(t, resultado.capaIds[0]);
    // 06:00 America/Mexico_City (UTC-6, sin horario de verano) == 12:00 UTC.
    expect(capa?.fechaEntrada).toBe(Date.parse('2026-08-10T12:00:00Z'));
  });

  test('rechaza una hora local que no existe por el cambio de horario de primavera (hueco)', async () => {
    const t = convexTest(schema, modules);
    await crearRolesPrueba(t); // EDS-105: requireAcceso resuelve el rol contra la tabla `roles`
    await crearParametrosPruebaConZona(t, 'America/New_York');
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);
    const matId = await crearMaterialPrueba(t, { esInterno: false });

    // 2026-03-08: en America/New_York el reloj salta de 02:00 a 03:00 —
    // 02:30 nunca existe ese día.
    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-03-08',
        horaCorte: '02:30',
        materiales: [{ materialId: matId, kgOriginal: 100, costoUnitario: 10 }],
        token: adminToken,
      })
    ).rejects.toThrow(/no existe en la zona horaria configurada/);

    const existencia = await t.query(api.peps.existenciaMaterial, { materialId: matId, token: adminToken });
    expect(existencia).toBe(0);
  });

  test('rechaza una hora local ambigua por el cambio de horario de otoño (ocurre dos veces)', async () => {
    const t = convexTest(schema, modules);
    await crearRolesPrueba(t); // EDS-105: requireAcceso resuelve el rol contra la tabla `roles`
    await crearParametrosPruebaConZona(t, 'America/New_York');
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const adminToken = await crearSesionPrueba(t, adminId);
    const matId = await crearMaterialPrueba(t, { esInterno: false });

    // 2026-11-01: en America/New_York el reloj retrocede de 02:00 a
    // 01:00 — 01:30 ocurre dos veces ese día (antes y después del cambio).
    await expect(
      t.mutation(api.importacionInicial.importarInventarioInicial, {
        fechaISO: '2026-11-01',
        horaCorte: '01:30',
        materiales: [{ materialId: matId, kgOriginal: 100, costoUnitario: 10 }],
        token: adminToken,
      })
    ).rejects.toThrow(/es ambigua en la zona horaria configurada/);

    const existencia = await t.query(api.peps.existenciaMaterial, { materialId: matId, token: adminToken });
    expect(existencia).toBe(0);
  });
});
