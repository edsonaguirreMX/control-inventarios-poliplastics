import { convexTest } from 'convex-test';
import { describe, expect, test } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { crearCapaImpl } from './peps';
import {
  crearMaterialPrueba, crearUsuarioPrueba, crearSesionPrueba, crearParametrosPrueba, crearRolesPrueba,
} from './testHelpers';
import { fechaOperativa, sumarDiasISO } from './lib/fechaOperativa';

const modules = import.meta.glob('./**/*.ts');
const ZONA = 'America/Mexico_City';
const T1 = '06:00';
const HOY = fechaOperativa(Date.now(), ZONA, T1);

// EDS-105 (Fase 2): estas funciones ahora usan requireAcceso, que resuelve
// el rol contra la tabla `roles` — necesitan que exista antes de crear
// sesiones con un rol real.
async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
  await crearRolesPrueba(t);
  await crearParametrosPrueba(t, 4);
  const adminId = await crearUsuarioPrueba(t, 'admin');
  const comprasId = await crearUsuarioPrueba(t, 'compras');
  const adminToken = await crearSesionPrueba(t, adminId);
  const comprasToken = await crearSesionPrueba(t, comprasId);
  return { adminId, comprasId, adminToken, comprasToken };
}

describe('ajustesInventario: autorización (solo admin)', () => {
  test('compras no puede crear ni leer ajustes', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await expect(
      t.mutation(api.ajustesInventario.crearAjusteEntrada, { materialId: matId, kg: 10, costoUnitario: 1, motivo: 'x', token: comprasToken })
    ).rejects.toThrow();
    await expect(
      t.mutation(api.ajustesInventario.crearAjusteSalida, { materialId: matId, kg: 10, motivo: 'x', token: comprasToken })
    ).rejects.toThrow();
    await expect(
      t.query(api.ajustesInventario.listAjustes, { desde: HOY, hasta: HOY, token: comprasToken })
    ).rejects.toThrow();
    await expect(
      t.query(api.ajustesInventario.listMaterialesParaAjuste, { token: comprasToken })
    ).rejects.toThrow();
  });
});

describe('ajustesInventario: ajuste de entrada', () => {
  test('crea una capa nueva y aumenta la existencia del material', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);

    await t.mutation(api.ajustesInventario.crearAjusteEntrada, {
      materialId: matId, kg: 50, costoUnitario: 3, motivo: 'Muestra recibida de proveedor', token: adminToken,
    });

    const existencia = await t.query(api.peps.existenciaMaterial, { materialId: matId, token: adminToken });
    expect(existencia).toBe(50);
  });

  test('costoUnitario puede ser 0 (muestra gratuita)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);

    await t.mutation(api.ajustesInventario.crearAjusteEntrada, {
      materialId: matId, kg: 20, costoUnitario: 0, motivo: 'Muestra gratuita', token: adminToken,
    });
    const valor = await t.query(api.peps.valorInventarioMaterial, { materialId: matId, token: adminToken });
    expect(valor).toBe(0);
  });

  test('aplica también a Triturado (esInterno)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const trituradoId = await crearMaterialPrueba(t, { esInterno: true, slug: 'triturado' });

    await t.mutation(api.ajustesInventario.crearAjusteEntrada, {
      materialId: trituradoId, kg: 15, costoUnitario: 0, motivo: 'Conteo físico encontró más Triturado del registrado', token: adminToken,
    });
    const existencia = await t.query(api.peps.existenciaMaterial, { materialId: trituradoId, token: adminToken });
    expect(existencia).toBe(15);
  });

  test('rechaza kg <= 0, costoUnitario negativo y motivo vacío', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);

    await expect(
      t.mutation(api.ajustesInventario.crearAjusteEntrada, { materialId: matId, kg: 0, costoUnitario: 1, motivo: 'x', token: adminToken })
    ).rejects.toThrow(/mayor a 0/);
    await expect(
      t.mutation(api.ajustesInventario.crearAjusteEntrada, { materialId: matId, kg: 10, costoUnitario: -1, motivo: 'x', token: adminToken })
    ).rejects.toThrow(/negativo/);
    await expect(
      t.mutation(api.ajustesInventario.crearAjusteEntrada, { materialId: matId, kg: 10, costoUnitario: 1, motivo: '   ', token: adminToken })
    ).rejects.toThrow(/motivo/);
  });

  test('rechaza material inactivo', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { activo: false });
    await expect(
      t.mutation(api.ajustesInventario.crearAjusteEntrada, { materialId: matId, kg: 10, costoUnitario: 1, motivo: 'x', token: adminToken })
    ).rejects.toThrow(/activo/);
  });

  test('se fecha con la fecha operativa de HOY, no un valor que el cliente pueda mandar (la mutation ni siquiera acepta fecha como argumento)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await t.mutation(api.ajustesInventario.crearAjusteEntrada, {
      materialId: matId, kg: 10, costoUnitario: 1, motivo: 'x', token: adminToken,
    });
    const ajustes = await t.query(api.ajustesInventario.listAjustes, { desde: HOY, hasta: HOY, token: adminToken });
    expect(ajustes).toHaveLength(1);
    expect(ajustes[0].fecha).toBe(HOY);
  });
});

describe('ajustesInventario: ajuste de salida', () => {
  test('consume FIFO y reduce la existencia; costoTotal refleja el costo real de las capas consumidas', async () => {
    const t = convexTest(schema, modules);
    const { adminId, adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await t.run((ctx) => crearCapaImpl(ctx, {
      materialId: matId, kgOriginal: 30, costoUnitario: 2, fechaEntrada: 1000,
      origen: 'entrada', entradaId: null, cierreTurnoId: null,
      origenTipo: 'entrada', origenId: 'setup-1', createdBy: adminId,
    }));
    await t.run((ctx) => crearCapaImpl(ctx, {
      materialId: matId, kgOriginal: 30, costoUnitario: 5, fechaEntrada: 2000,
      origen: 'entrada', entradaId: null, cierreTurnoId: null,
      origenTipo: 'entrada', origenId: 'setup-2', createdBy: adminId,
    }));

    await t.mutation(api.ajustesInventario.crearAjusteSalida, {
      materialId: matId, kg: 40, motivo: 'Faltante detectado en conteo físico', token: adminToken,
    });

    // FIFO: toma las 30kg de la capa más vieja ($2) + 10kg de la siguiente ($5)
    const existencia = await t.query(api.peps.existenciaMaterial, { materialId: matId, token: adminToken });
    expect(existencia).toBe(20);

    const ajustes = await t.query(api.ajustesInventario.listAjustes, { desde: HOY, hasta: HOY, token: adminToken });
    expect(ajustes[0].costoTotal).toBe(30 * 2 + 10 * 5);
    expect(ajustes[0].costoUnitario).toBeNull();
  });

  test('bloquea si kg excede la existencia disponible, sin modificar nada', async () => {
    const t = convexTest(schema, modules);
    const { adminId, adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await t.run((ctx) => crearCapaImpl(ctx, {
      materialId: matId, kgOriginal: 10, costoUnitario: 1, fechaEntrada: 1000,
      origen: 'entrada', entradaId: null, cierreTurnoId: null,
      origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
    }));

    await expect(
      t.mutation(api.ajustesInventario.crearAjusteSalida, { materialId: matId, kg: 20, motivo: 'x', token: adminToken })
    ).rejects.toThrow(/[Ee]xistencia insuficiente/);

    const existencia = await t.query(api.peps.existenciaMaterial, { materialId: matId, token: adminToken });
    expect(existencia).toBe(10); // sin cambios
    const ajustes = await t.query(api.ajustesInventario.listAjustes, { desde: HOY, hasta: HOY, token: adminToken });
    expect(ajustes).toHaveLength(0); // no quedó ningún registro huérfano
  });

  // El punto central del diseño: a diferencia del consumo de producción
  // (donde Triturado SÍ puede quedar "en falta" porque es física real de
  // la operación), un ajuste manual de salida sobre Triturado debe
  // bloquear igual que cualquier otro material — no hay justificación
  // para dejarlo "inventar" un faltante fantasma por error de captura.
  test('bloquea también en Triturado (esInterno) — sin la excepción que sí aplica al consumo de producción', async () => {
    const t = convexTest(schema, modules);
    const { adminId, adminToken } = await setup(t);
    const trituradoId = await crearMaterialPrueba(t, { esInterno: true, slug: 'triturado' });
    await t.run((ctx) => crearCapaImpl(ctx, {
      materialId: trituradoId, kgOriginal: 5, costoUnitario: 0, fechaEntrada: 1000,
      origen: 'triturado', entradaId: null, cierreTurnoId: null,
      origenTipo: 'cierreTurno', origenId: 'setup', createdBy: adminId,
    }));

    await expect(
      t.mutation(api.ajustesInventario.crearAjusteSalida, { materialId: trituradoId, kg: 100, motivo: 'x', token: adminToken })
    ).rejects.toThrow(/[Ee]xistencia insuficiente/);

    const existencia = await t.query(api.peps.existenciaMaterial, { materialId: trituradoId, token: adminToken });
    expect(existencia).toBe(5); // sin cambios
  });

  test('rechaza kg <= 0 y motivo vacío', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await expect(
      t.mutation(api.ajustesInventario.crearAjusteSalida, { materialId: matId, kg: 0, motivo: 'x', token: adminToken })
    ).rejects.toThrow(/mayor a 0/);
    await expect(
      t.mutation(api.ajustesInventario.crearAjusteSalida, { materialId: matId, kg: 10, motivo: '', token: adminToken })
    ).rejects.toThrow(/motivo/);
  });
});

describe('ajustesInventario: listAjustes (reporte por rango de fechas)', () => {
  test('filtra correctamente por el rango desde/hasta (inclusive)', async () => {
    const t = convexTest(schema, modules);
    const { adminId, adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    const ayer = sumarDiasISO(HOY, -1);
    const anteayer = sumarDiasISO(HOY, -2);

    // Simula un ajuste de "ayer" insertando directo (crearAjusteEntradaImpl
    // siempre usa fecha=hoy — la única forma de tener otra fecha en la
    // tabla en un test es insertarla directo, igual que otros tests de
    // este proyecto simulan datos de otros días).
    await t.run((ctx) => ctx.db.insert('ajustesInventario', {
      materialId: matId, tipo: 'entrada', kg: 5, motivo: 'ayer', fecha: ayer,
      costoUnitario: 1, costoTotal: 5, capaId: null, capasDetalle: null,
      registradoPor: adminId, createdAt: Date.now(),
    }));
    await t.run((ctx) => ctx.db.insert('ajustesInventario', {
      materialId: matId, tipo: 'entrada', kg: 5, motivo: 'anteayer', fecha: anteayer,
      costoUnitario: 1, costoTotal: 5, capaId: null, capasDetalle: null,
      registradoPor: adminId, createdAt: Date.now(),
    }));
    await t.mutation(api.ajustesInventario.crearAjusteEntrada, {
      materialId: matId, kg: 5, costoUnitario: 1, motivo: 'hoy', token: adminToken,
    });

    const soloHoy = await t.query(api.ajustesInventario.listAjustes, { desde: HOY, hasta: HOY, token: adminToken });
    expect(soloHoy).toHaveLength(1);
    expect(soloHoy[0].motivo).toBe('hoy');

    const rangoCompleto = await t.query(api.ajustesInventario.listAjustes, { desde: anteayer, hasta: HOY, token: adminToken });
    expect(rangoCompleto).toHaveLength(3);
    expect(rangoCompleto.map((a) => a.motivo).sort()).toEqual(['anteayer', 'ayer', 'hoy']);
  });

  test('incluye nombre/variante del material y nombre de quien lo capturó', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const matId = await crearMaterialPrueba(t, { nombre: 'HDPE reciclado' });

    await t.mutation(api.ajustesInventario.crearAjusteEntrada, {
      materialId: matId, kg: 5, costoUnitario: 1, motivo: 'x', token: adminToken,
    });
    const ajustes = await t.query(api.ajustesInventario.listAjustes, { desde: HOY, hasta: HOY, token: adminToken });
    expect(ajustes[0].nombre).toBe('HDPE reciclado');
    expect(ajustes[0].variante).toBe('temporal'); // default de crearMaterialPrueba
    expect(ajustes[0].registradoPorNombre).toBe('Test admin');
  });
});

describe('ajustesInventario: listMaterialesParaAjuste', () => {
  test('incluye Triturado (a diferencia de entradas.listMaterialesActivos, que lo excluye)', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await crearMaterialPrueba(t, { esInterno: true, slug: 'triturado', nombre: 'Triturado' });
    await crearMaterialPrueba(t, { nombre: 'HDPE reciclado' });

    const materiales = await t.query(api.ajustesInventario.listMaterialesParaAjuste, { token: adminToken });
    expect(materiales.some((m) => m.nombre === 'Triturado')).toBe(true);
    expect(materiales.some((m) => m.nombre === 'HDPE reciclado')).toBe(true);
  });

  test('excluye materiales inactivos', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await crearMaterialPrueba(t, { nombre: 'Descontinuado', activo: false });
    const materiales = await t.query(api.ajustesInventario.listMaterialesParaAjuste, { token: adminToken });
    expect(materiales.some((m) => m.nombre === 'Descontinuado')).toBe(false);
  });
});
