import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearCapaImpl, consumirFIFOImpl, revertirConsumoImpl } from './peps';
import { crearMaterialPrueba, crearUsuarioPrueba, crearSesionPrueba, crearRolesPrueba, getCapa } from './testHelpers';

const modules = import.meta.glob('./**/*.ts');

describe('peps: motor PEPS/FIFO (tarea 3.1)', () => {
  test('FIFO real: 2 capas, consumir 150kg deja la 1ª agotada y la 2ª con 50kg', async () => {
    const t = convexTest(schema, modules);
    const matId = await crearMaterialPrueba(t, { esInterno: false });
    const userId = await crearUsuarioPrueba(t, 'admin');

    const capaA = await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 100, costoUnitario: 10, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'A', createdBy: userId,
      })
    );
    const capaB = await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 100, costoUnitario: 12, fechaEntrada: 2000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'B', createdBy: userId,
      })
    );

    const resultado = await t.run((ctx) =>
      consumirFIFOImpl(ctx, { materialId: matId, kgAConsumir: 150, origenTipo: 'cierreTurno', origenId: 'x', createdBy: userId })
    );

    expect(resultado.costoTotal).toBe(100 * 10 + 50 * 12);
    expect(resultado.faltanteKg).toBe(0);
    expect(resultado.capasDetalle).toHaveLength(2);

    const a = await getCapa(t, capaA);
    const b = await getCapa(t, capaB);
    expect(a?.kgRestante).toBe(0);
    expect(a?.agotada).toBe(true);
    expect(b?.kgRestante).toBe(50);
    expect(b?.agotada).toBe(false);
  });

  test('FIFO respeta fechaEntrada REAL, no el orden en que se costeó/creó el registro', async () => {
    const t = convexTest(schema, modules);
    const matId = await crearMaterialPrueba(t);
    const userId = await crearUsuarioPrueba(t, 'admin');

    // Se COSTEA primero la entrada del 10/agosto ($20) y DESPUÉS la del
    // 1/agosto ($9) — pero la del 1/agosto es la que debe consumirse
    // primero porque su fechaEntrada real es anterior.
    const capaCosteadaPrimero = await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 50, costoUnitario: 20,
        fechaEntrada: Date.parse('2026-08-10T00:00:00Z'),
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'tarde', createdBy: userId,
      })
    );
    const capaConFechaMasAntigua = await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 50, costoUnitario: 9,
        fechaEntrada: Date.parse('2026-08-01T00:00:00Z'),
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'antigua', createdBy: userId,
      })
    );

    const resultado = await t.run((ctx) =>
      consumirFIFOImpl(ctx, { materialId: matId, kgAConsumir: 30, origenTipo: 'cierreTurno', origenId: 'x', createdBy: userId })
    );

    expect(resultado.costoTotal).toBe(30 * 9); // consumió de la capa con fecha más antigua, no la costeada primero
    expect(resultado.capasDetalle[0].capaId).toBe(capaConFechaMasAntigua);

    const tardeSinTocar = await getCapa(t, capaCosteadaPrimero);
    expect(tardeSinTocar?.kgRestante).toBe(50); // intacta
  });

  test('bloquea por faltante en material normal y no modifica nada', async () => {
    const t = convexTest(schema, modules);
    const matId = await crearMaterialPrueba(t, { esInterno: false });
    const userId = await crearUsuarioPrueba(t, 'admin');

    const capaId = await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 50, costoUnitario: 5, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'x', createdBy: userId,
      })
    );

    await expect(
      t.run((ctx) => consumirFIFOImpl(ctx, { materialId: matId, kgAConsumir: 999, origenTipo: 'cierreTurno', origenId: 'x', createdBy: userId }))
    ).rejects.toThrow(/Inventario insuficiente/);

    const capa = await getCapa(t, capaId);
    expect(capa?.kgRestante).toBe(50); // sin cambios
  });

  test('Triturado (esInterno) permite faltante sin error, costo siempre $0', async () => {
    const t = convexTest(schema, modules);
    const trituradoId = await crearMaterialPrueba(t, { esInterno: true });
    const userId = await crearUsuarioPrueba(t, 'admin');

    const capaId = await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: trituradoId, kgOriginal: 50, costoUnitario: 0, fechaEntrada: 1000,
        origen: 'triturado', entradaId: null, cierreTurnoId: null,
        origenTipo: 'cierreTurno', origenId: 'x', createdBy: userId,
      })
    );

    const resultado = await t.run((ctx) =>
      consumirFIFOImpl(ctx, { materialId: trituradoId, kgAConsumir: 80, origenTipo: 'cierreTurno', origenId: 'x', createdBy: userId })
    );

    expect(resultado.faltanteKg).toBe(30);
    expect(resultado.costoTotal).toBe(0);
    const capa = await getCapa(t, capaId);
    expect(capa?.agotada).toBe(true);
    expect(capa?.kgRestante).toBe(0);
  });

  test('revertirConsumo deja las capas exactamente como antes de consumir', async () => {
    const t = convexTest(schema, modules);
    const matId = await crearMaterialPrueba(t);
    const userId = await crearUsuarioPrueba(t, 'admin');

    const capaA = await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 100, costoUnitario: 10, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'A', createdBy: userId,
      })
    );
    const capaB = await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 100, costoUnitario: 12, fechaEntrada: 2000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'B', createdBy: userId,
      })
    );

    const consumo = await t.run((ctx) =>
      consumirFIFOImpl(ctx, { materialId: matId, kgAConsumir: 150, origenTipo: 'cierreTurno', origenId: 'x', createdBy: userId })
    );

    // Simula el registro cierreConsumos que crearía cierreEngine.ts, para
    // poder ejercitar revertirConsumoImpl igual que lo haría el motor real.
    const cierreDummyId = await t.run(async (ctx) => {
      const now = Date.now();
      return ctx.db.insert('cierresTurno', {
        fecha: '2000-01-01', linea: 1, turno: 1, cargasPreparadas: 0, metrosBuenos: 0,
        caballetes105Pzas: 0, caballetes106Pzas: 0, kgBuenos: 0, caballetesKg: 0, mermaTotalKg: 0,
        trituradoKg: 0, costoTotalConsumido: 0, costoRealPorKg: 0, costoRealPorMetro: 0,
        capturadoPor: userId, capturadoEn: now, editado: false, editadoPor: null, editadoEn: null,
        vecesRecapturado: 0,
      });
    });
    const cierreConsumoId = await t.run((ctx) =>
      ctx.db.insert('cierreConsumos', {
        cierreTurnoId: cierreDummyId, materialId: matId, kgConsumido: 150, costoTotal: consumo.costoTotal,
        faltanteKg: 0, vigente: true, capasDetalle: consumo.capasDetalle,
      })
    );

    await t.run((ctx) => revertirConsumoImpl(ctx, { cierreConsumoId, createdBy: userId }));

    const a = await getCapa(t, capaA);
    const b = await getCapa(t, capaB);
    expect(a?.kgRestante).toBe(100);
    expect(a?.agotada).toBe(false);
    expect(b?.kgRestante).toBe(100);
    expect(b?.agotada).toBe(false);
  });

  test('reconciliación: generacion - consumo + reversa_consumo == kgRestante', async () => {
    const t = convexTest(schema, modules);
    const matId = await crearMaterialPrueba(t);
    const userId = await crearUsuarioPrueba(t, 'admin');

    const capaId = await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 100, costoUnitario: 10, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'x', createdBy: userId,
      })
    );
    await t.run((ctx) => consumirFIFOImpl(ctx, { materialId: matId, kgAConsumir: 40, origenTipo: 'cierreTurno', origenId: 'x', createdBy: userId }));

    const movs = await t.run((ctx) => ctx.db.query('capaMovimientos').withIndex('by_capaId', (q) => q.eq('capaId', capaId)).collect());
    const neto = movs.reduce((n, m) => {
      if (m.tipo === 'generacion' || m.tipo === 'reversa_consumo') return n + m.kg;
      if (m.tipo === 'consumo') return n - m.kg;
      return n;
    }, 0);
    const capa = await getCapa(t, capaId);
    expect(neto).toBe(capa?.kgRestante);
    expect(neto).toBe(60);
  });
});

// EDS-66 (auditoría final de PR8): existenciaMaterial/valorInventarioMaterial
// no tenían NINGUNA cobertura de prueba en todo el repo, pese a ser queries
// públicas que exponen datos financieros y están gateadas por rol — no las
// llama ninguna pantalla hoy (dashboard.ts calcula lo mismo en bulk para su
// propio uso), pero siguen siendo superficie real de la API pública de
// Convex: cualquiera con una sesión válida del rol correcto puede llamarlas
// directo, sin pasar por el frontend. "Nadie las usa desde la UI" no es lo
// mismo que "no hace falta que rechacen roles indebidos".
describe('peps: existenciaMaterial / valorInventarioMaterial — autorización server-side (EDS-66)', () => {
  async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
    await crearRolesPrueba(t); // EDS-105: requireAcceso (existenciaMaterial) resuelve el rol contra la tabla `roles`
    const matId = await crearMaterialPrueba(t, { esInterno: false });
    const adminId = await crearUsuarioPrueba(t, 'admin');
    const comprasId = await crearUsuarioPrueba(t, 'compras');
    const calidadId = await crearUsuarioPrueba(t, 'calidad');
    const gerenciaId = await crearUsuarioPrueba(t, 'gerencia');
    const operadorId = await crearUsuarioPrueba(t, 'operador');
    const adminToken = await crearSesionPrueba(t, adminId);
    const comprasToken = await crearSesionPrueba(t, comprasId);
    const calidadToken = await crearSesionPrueba(t, calidadId);
    const gerenciaToken = await crearSesionPrueba(t, gerenciaId);
    const operadorToken = await crearSesionPrueba(t, operadorId);
    await t.run((ctx) =>
      crearCapaImpl(ctx, {
        materialId: matId, kgOriginal: 100, costoUnitario: 10, fechaEntrada: 1000,
        origen: 'entrada', entradaId: null, cierreTurnoId: null,
        origenTipo: 'entrada', origenId: 'x', createdBy: adminId,
      })
    );
    return { matId, adminToken, comprasToken, calidadToken, gerenciaToken, operadorToken };
  }

  test('existenciaMaterial: operador (rol no permitido) es rechazado', async () => {
    const t = convexTest(schema, modules);
    const { matId, operadorToken } = await setup(t);
    await expect(
      t.query(api.peps.existenciaMaterial, { materialId: matId, token: operadorToken })
    ).rejects.toThrow();
  });

  test('existenciaMaterial: compras/calidad/gerencia/admin sí pueden leerla y el valor es correcto', async () => {
    const t = convexTest(schema, modules);
    const { matId, comprasToken, calidadToken, gerenciaToken, adminToken } = await setup(t);
    for (const token of [comprasToken, calidadToken, gerenciaToken, adminToken]) {
      const existencia = await t.query(api.peps.existenciaMaterial, { materialId: matId, token });
      expect(existencia).toBe(100);
    }
  });

  test('valorInventarioMaterial: operador (rol no permitido) es rechazado', async () => {
    const t = convexTest(schema, modules);
    const { matId, operadorToken } = await setup(t);
    await expect(
      t.query(api.peps.valorInventarioMaterial, { materialId: matId, token: operadorToken })
    ).rejects.toThrow();
  });

  test('valorInventarioMaterial: calidad (rol no permitido — esta query sí expone costo) es rechazado', async () => {
    const t = convexTest(schema, modules);
    const { matId, calidadToken } = await setup(t);
    await expect(
      t.query(api.peps.valorInventarioMaterial, { materialId: matId, token: calidadToken })
    ).rejects.toThrow();
  });

  test('valorInventarioMaterial: compras/gerencia/admin sí pueden leerla y el valor es correcto', async () => {
    const t = convexTest(schema, modules);
    const { matId, comprasToken, gerenciaToken, adminToken } = await setup(t);
    for (const token of [comprasToken, gerenciaToken, adminToken]) {
      const valor = await t.query(api.peps.valorInventarioMaterial, { materialId: matId, token });
      expect(valor).toBe(100 * 10);
    }
  });
});
