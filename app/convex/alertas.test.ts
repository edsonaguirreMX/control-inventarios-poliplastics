import { convexTest } from 'convex-test';
import { describe, expect, test, vi, afterEach } from 'vitest';
import schema from './schema';
import { internal, api } from './_generated/api';
import { crearCapaImpl } from './peps';
import { crearMaterialPrueba, crearUsuarioPrueba, crearSesionPrueba, crearParametrosPrueba, crearReglasAlertaPrueba } from './testHelpers';
import { fechaOperativa, horaLocalAInstante } from './lib/fechaOperativa';

const modules = import.meta.glob('./**/*.ts');
const ZONA = 'America/Mexico_City';
const T1 = '06:00';
const HOY = fechaOperativa(Date.now(), ZONA, T1);

async function setup(t: Awaited<ReturnType<typeof convexTest>>) {
  await crearParametrosPrueba(t, 4);
  await crearReglasAlertaPrueba(t); // las 7 reglas reales — evaluarAlertas las necesita, convex-test no corre seed.ts solo
  await crearMaterialPrueba(t, { slug: 'triturado', esInterno: true }); // requerido por aplicarCierreImpl
  const adminId = await crearUsuarioPrueba(t, 'admin');
  const compradorId = await crearUsuarioPrueba(t, 'compras');
  const adminToken = await crearSesionPrueba(t, adminId);
  const comprasToken = await crearSesionPrueba(t, compradorId);
  return { adminId, compradorId, adminToken, comprasToken };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('alertas: listReglas/updateRegla/guardarReglasCompleto (tarea 7.1)', () => {
  test('rechaza roles que no sean admin', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await expect(t.query(api.alertas.listReglas, { token: comprasToken })).rejects.toThrow();
    await expect(
      t.mutation(api.alertas.updateRegla, { slug: 'merma-alta', activa: false, token: comprasToken })
    ).rejects.toThrow();
  });

  test('listReglas trae las 7 reglas sembradas', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    const reglas = await t.query(api.alertas.listReglas, { token: adminToken });
    expect(reglas).toHaveLength(7);
    expect(reglas.some((r) => r.slug === 'material-critico')).toBe(true);
  });

  test('updateRegla persiste activa/umbral/destinatarios/canales', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.run((ctx) => ctx.db.insert('alertasReglas', {
      slug: 'test-regla', nombre: 'Test', descripcion: '', activa: true, umbral: 10, unidad: '%',
      destinatariosRoles: ['admin'], canales: ['sistema'], updatedAt: Date.now(), updatedBy: null,
    }));
    await t.mutation(api.alertas.updateRegla, {
      slug: 'test-regla', activa: false, umbral: 25, destinatariosRoles: ['compras', 'admin'], canales: ['sistema', 'correo'], token: adminToken,
    });
    const reglas = await t.query(api.alertas.listReglas, { token: adminToken });
    const r = reglas.find((x) => x.slug === 'test-regla');
    expect(r?.activa).toBe(false);
    expect(r?.umbral).toBe(25);
    expect(r?.destinatariosRoles).toEqual(['compras', 'admin']);
  });

  test('rechaza destinatarios o canales vacíos', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.run((ctx) => ctx.db.insert('alertasReglas', {
      slug: 'test-regla', nombre: 'Test', descripcion: '', activa: true, umbral: null, unidad: null,
      destinatariosRoles: ['admin'], canales: ['sistema'], updatedAt: Date.now(), updatedBy: null,
    }));
    await expect(
      t.mutation(api.alertas.updateRegla, { slug: 'test-regla', destinatariosRoles: [], token: adminToken })
    ).rejects.toThrow(/destinatario/);
    await expect(
      t.mutation(api.alertas.updateRegla, { slug: 'test-regla', canales: [], token: adminToken })
    ).rejects.toThrow(/canal/);
  });

  test('guardarReglasCompleto es atómico — BUG DE INTEGRIDAD REGRESIÓN: si una regla del batch falla, NINGUNA queda guardada', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.run((ctx) => ctx.db.insert('alertasReglas', {
      slug: 'regla-a', nombre: 'A', descripcion: '', activa: true, umbral: null, unidad: null,
      destinatariosRoles: ['admin'], canales: ['sistema'], updatedAt: Date.now(), updatedBy: null,
    }));

    await expect(
      t.mutation(api.alertas.guardarReglasCompleto, {
        reglas: [
          { slug: 'regla-a', activa: false },
          { slug: 'no-existe', activa: false },
        ],
        token: adminToken,
      })
    ).rejects.toThrow(/no existe/);

    const reglas = await t.query(api.alertas.listReglas, { token: adminToken });
    expect(reglas.find((r) => r.slug === 'regla-a')?.activa).toBe(true); // no quedó en false
  });
});

describe('alertas: marcarAlertaLeida / marcarTodasLeidas / noLeidasParaMi (tarea 7.1)', () => {
  test('marcarAlertaLeida es idempotente vía el índice compuesto — marcar dos veces no duplica ni falla', async () => {
    const t = convexTest(schema, modules);
    const { adminToken, adminId } = await setup(t);
    const alertaId = await t.run((ctx) => ctx.db.insert('alertasHistorial', {
      reglaSlug: 'merma-alta', fecha: Date.now(), detalle: 'test', dedupeKey: 'x',
      destinatariosRoles: ['admin'], canales: ['sistema'],
    }));
    await t.mutation(api.alertas.marcarAlertaLeida, { alertaId, token: adminToken });
    await t.mutation(api.alertas.marcarAlertaLeida, { alertaId, token: adminToken });
    const lecturas = await t.run((ctx) => ctx.db.query('alertasLecturas').withIndex('by_userId', (q) => q.eq('userId', adminId)).collect());
    expect(lecturas).toHaveLength(1);
  });

  test('una alerta leída por un rol sigue sin leer para otro rol distinto', async () => {
    const t = convexTest(schema, modules);
    const { adminToken, comprasToken } = await setup(t);
    await t.run((ctx) => ctx.db.insert('alertasHistorial', {
      reglaSlug: 'material-critico', fecha: Date.now(), detalle: 'test', dedupeKey: 'x',
      destinatariosRoles: ['admin', 'compras'], canales: ['sistema'],
    }));
    await t.mutation(api.alertas.marcarAlertaLeida, { alertaId: (await t.query(api.alertas.noLeidasParaMi, { token: adminToken }))[0]._id, token: adminToken });

    const noLeidasAdmin = await t.query(api.alertas.noLeidasParaMi, { token: adminToken });
    const noLeidasCompras = await t.query(api.alertas.noLeidasParaMi, { token: comprasToken });
    expect(noLeidasAdmin).toHaveLength(0);
    expect(noLeidasCompras).toHaveLength(1);
  });

  test('noLeidasParaMi filtra por si el rol está en destinatariosRoles', async () => {
    const t = convexTest(schema, modules);
    const { comprasToken } = await setup(t);
    await t.run((ctx) => ctx.db.insert('alertasHistorial', {
      reglaSlug: 'costo-alto', fecha: Date.now(), detalle: 'solo gerencia', dedupeKey: 'x',
      destinatariosRoles: ['gerencia', 'admin'], canales: ['sistema'],
    }));
    const noLeidas = await t.query(api.alertas.noLeidasParaMi, { token: comprasToken });
    expect(noLeidas).toHaveLength(0);
  });

  test('marcarTodasLeidas es atómico y marca solo las relevantes para el rol de quien la llama', async () => {
    const t = convexTest(schema, modules);
    const { adminToken } = await setup(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('alertasHistorial', {
          reglaSlug: 'merma-alta', fecha: Date.now(), detalle: `a${i}`, dedupeKey: `x${i}`,
          destinatariosRoles: ['admin'], canales: ['sistema'],
        });
      }
    });
    const resultado = await t.mutation(api.alertas.marcarTodasLeidas, { token: adminToken });
    expect(resultado.marcadas).toBe(3);
    const noLeidas = await t.query(api.alertas.noLeidasParaMi, { token: adminToken });
    expect(noLeidas).toHaveLength(0);
  });
});

describe('alertas: evaluarAlertas (tarea 7.2) — motor de evaluación', () => {
  test('material-critico dispara cuando existencia < punto de reorden, y NO duplica si el cron corre dos veces el mismo día', async () => {
    const t = convexTest(schema, modules);
    const { adminId } = await setup(t);
    const matId = await crearMaterialPrueba(t, { reorderMode: 'manual', reorderManualKg: 999999 });
    await t.run((ctx) => crearCapaImpl(ctx, {
      materialId: matId, kgOriginal: 100, costoUnitario: 1, fechaEntrada: 1000,
      origen: 'entrada', entradaId: null, cierreTurnoId: null,
      origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
    }));

    await t.mutation(internal.alertas.evaluarAlertas, {});
    await t.mutation(internal.alertas.evaluarAlertas, {}); // corre dos veces — no debe duplicar

    const historial = await t.run((ctx) => ctx.db.query('alertasHistorial').withIndex('by_dedupeKey', (q) => q.eq('dedupeKey', `material-critico:${matId}:${HOY}`)).collect());
    expect(historial).toHaveLength(1);
    expect(historial[0].detalle).toMatch(/bajo el punto de reorden/);
  });

  test('material-critico NO dispara si la regla está desactivada', async () => {
    const t = convexTest(schema, modules);
    const { adminId } = await setup(t);
    const matId = await crearMaterialPrueba(t, { reorderMode: 'manual', reorderManualKg: 999999 });
    await t.run((ctx) => crearCapaImpl(ctx, {
      materialId: matId, kgOriginal: 100, costoUnitario: 1, fechaEntrada: 1000,
      origen: 'entrada', entradaId: null, cierreTurnoId: null,
      origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
    }));
    await t.run((ctx) => ctx.db.query('alertasReglas').withIndex('by_slug', (q) => q.eq('slug', 'material-critico')).unique()
      .then((r) => r && ctx.db.patch(r._id, { activa: false })));

    await t.mutation(internal.alertas.evaluarAlertas, {});
    const historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    expect(historial.find((h) => h.reglaSlug === 'material-critico')).toBeUndefined();
  });

  test('material-por-vencer dispara en la zona amarilla, pero NO si ya es crítico (evita doble alerta el mismo día)', async () => {
    const t = convexTest(schema, modules);
    const { adminId } = await setup(t);
    // reorderManualKg=100, existencia=105 → dentro del margen de 15% (115) pero NO por debajo de 100 → "por vencer", no "crítico".
    const matId = await crearMaterialPrueba(t, { reorderMode: 'manual', reorderManualKg: 100 });
    await t.run((ctx) => crearCapaImpl(ctx, {
      materialId: matId, kgOriginal: 105, costoUnitario: 1, fechaEntrada: 1000,
      origen: 'entrada', entradaId: null, cierreTurnoId: null,
      origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
    }));

    await t.mutation(internal.alertas.evaluarAlertas, {});
    const historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    expect(historial.find((h) => h.reglaSlug === 'material-por-vencer')).toBeDefined();
    expect(historial.find((h) => h.reglaSlug === 'material-critico')).toBeUndefined();
  });

  test('merma-alta dispara cuando %merma supera meta+umbral, usando el mismo cálculo que Panel de Control', async () => {
    const t = convexTest(schema, modules);
    const { adminId } = await setup(t);
    const operadorId = await crearUsuarioPrueba(t, 'operador');
    const operadorToken = await crearSesionPrueba(t, operadorId);
    const matId = await crearMaterialPrueba(t);
    await t.run((ctx) => crearCapaImpl(ctx, {
      materialId: matId, kgOriginal: 100000, costoUnitario: 1, fechaEntrada: 1000,
      origen: 'entrada', entradaId: null, cierreTurnoId: null,
      origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
    }));
    // kgBuenos = 20m × 4kg/m (kgPorMetro de crearParametrosPrueba) = 80kg;
    // merma = 100-80 = 20kg → %merma = 20/100*100 = 20% — muy por arriba de meta(5%)+umbral(1pp por default).
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 20,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 100 }],
      token: operadorToken,
    });

    await t.mutation(internal.alertas.evaluarAlertas, {});
    const historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    const alerta = historial.find((h) => h.reglaSlug === 'merma-alta');
    expect(alerta).toBeDefined();
    expect(alerta?.detalle).toMatch(/20\.0%/);
  });

  // EDS-90 (revisión post-No-Go): merma-alta/costo-alto ahora evalúan
  // contra el último cierre real en vez de "hoy" — pero el dedupe original
  // seguía usando la fecha operativa del CRON, no la del cierre de
  // referencia. Resultado: si pasaban varios días sin un cierre nuevo, el
  // cron generaba una alerta idéntica cada día por el mismo cierre viejo
  // (ruido operativo real). El fix dedupea merma-alta/costo-alto por la
  // fecha del cierre de referencia — este test prueba ambos lados: no debe
  // duplicar mientras el cierre de referencia no cambie, pero sí debe
  // alertar de nuevo cuando SÍ se captura un cierre nuevo con merma alta.
  test('merma-alta no duplica alerta si el cierre de referencia no cambia, pero sí alerta de nuevo con un cierre nuevo', async () => {
    const t = convexTest(schema, modules);
    const { adminId } = await setup(t);
    const operadorToken = await crearSesionPrueba(t, await crearUsuarioPrueba(t, 'operador'));
    const matId = await crearMaterialPrueba(t);
    await t.run((ctx) => crearCapaImpl(ctx, {
      materialId: matId, kgOriginal: 100000, costoUnitario: 1, fechaEntrada: 1000,
      origen: 'entrada', entradaId: null, cierreTurnoId: null,
      origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
    }));
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 20,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 100 }], // 20% merma
      token: operadorToken,
    });
    await t.mutation(internal.alertas.evaluarAlertas, {});

    // El cron vuelve a correr 2 días después SIN ningún cierre nuevo — el
    // último cierre de referencia sigue siendo el mismo. No debe insertar
    // una segunda alerta idéntica.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await t.mutation(internal.alertas.evaluarAlertas, {});
    let historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    expect(historial.filter((h) => h.reglaSlug === 'merma-alta').length).toBe(1);

    // Ahora sí se captura un cierre NUEVO (fecha distinta), todavía con
    // merma alta — esto es un evento real y nuevo, sí debe generar una
    // segunda alerta (la sesión se crea DESPUÉS de fijar la hora falsa,
    // igual que en los tests de turno-sin-cerrar, para que su expiresAt
    // quede en el futuro respecto al reloj adelantado).
    const operadorToken2 = await crearSesionPrueba(t, await crearUsuarioPrueba(t, 'operador'));
    const hoyFake = fechaOperativa(Date.now(), ZONA, T1);
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: hoyFake, linea: 2, turno: 1, cargasPreparadas: 1, metrosBuenos: 20,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 100 }], // 20% merma otra vez
      token: operadorToken2,
    });
    await t.mutation(internal.alertas.evaluarAlertas, {});
    historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    expect(historial.filter((h) => h.reglaSlug === 'merma-alta').length).toBe(2);
  });

  // Cobertura simétrica pedida en revisión (CodeRabbit, PR EDS-90): el test
  // anterior solo prueba merma-alta — costo-alto comparte exactamente el
  // mismo mecanismo de disparar()/fechaDedupe, pero es una regla
  // independiente y una regresión ahí (p.ej. alguien vuelve a pasar `hoy`
  // en vez de `kpis.fecha` solo en esta rama) no la detectaría el test de
  // merma-alta.
  test('costo-alto no duplica alerta si el cierre de referencia no cambia, pero sí alerta de nuevo con un cierre nuevo', async () => {
    const t = convexTest(schema, modules);
    const { adminId } = await setup(t);
    const operadorToken = await crearSesionPrueba(t, await crearUsuarioPrueba(t, 'operador'));
    // costoEstandar=1 × kgPorCarga=10 (única entrada de fórmula) → costoEstandarPorKg=1.
    const matId = await crearMaterialPrueba(t, { costoEstandar: 1 });
    await t.run((ctx) => ctx.db.insert('formulaCarga', { materialId: matId, kgPorCarga: 10, nota: '', updatedAt: Date.now() }));
    await t.run((ctx) => crearCapaImpl(ctx, {
      materialId: matId, kgOriginal: 100000, costoUnitario: 5, fechaEntrada: 1000,
      origen: 'entrada', entradaId: null, cierreTurnoId: null,
      origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
    }));
    // kgBuenos = 20m × 4kg/m = 80kg; costoTotal = 100kg × $5 = $500 →
    // costoRealPorKgUltimoCierre = 500/80 = $6.25 — muy por arriba del
    // estándar ($1) + margen (5% por default).
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 20,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 100 }],
      token: operadorToken,
    });
    await t.mutation(internal.alertas.evaluarAlertas, {});
    let historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    expect(historial.filter((h) => h.reglaSlug === 'costo-alto').length).toBe(1);

    // El cron vuelve a correr 2 días después SIN ningún cierre nuevo — no
    // debe insertar una segunda alerta idéntica.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await t.mutation(internal.alertas.evaluarAlertas, {});
    historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    expect(historial.filter((h) => h.reglaSlug === 'costo-alto').length).toBe(1);

    // Un cierre NUEVO (fecha distinta), todavía con costo alto, sí debe
    // generar una segunda alerta.
    const operadorToken2 = await crearSesionPrueba(t, await crearUsuarioPrueba(t, 'operador'));
    const hoyFake = fechaOperativa(Date.now(), ZONA, T1);
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: hoyFake, linea: 2, turno: 1, cargasPreparadas: 1, metrosBuenos: 20,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 100 }],
      token: operadorToken2,
    });
    await t.mutation(internal.alertas.evaluarAlertas, {});
    historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    expect(historial.filter((h) => h.reglaSlug === 'costo-alto').length).toBe(2);
  });

  test('produccion-baja NO dispara si el objetivo semanal es 0 (evita falso positivo por división entre cero)', async () => {
    const t = convexTest(schema, modules);
    await setup(t);
    // objetivosProduccion nunca se configuró (semana=0 por default de getObjetivos, pero aquí ni existe el doc).
    await t.mutation(internal.alertas.evaluarAlertas, {});
    const historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    expect(historial.find((h) => h.reglaSlug === 'produccion-baja')).toBeUndefined();
  });

  test('produccion-baja dispara cuando la producción acumulada de la semana cae debajo del umbral', async () => {
    const t = convexTest(schema, modules);
    const { adminId, adminToken } = await setup(t);
    const operadorId = await crearUsuarioPrueba(t, 'operador');
    const operadorToken = await crearSesionPrueba(t, operadorId);
    await t.mutation(api.dashboard.updateObjetivos, { turnoL1: 1, turnoL2: 1, semana: 1000, mes: 1, token: adminToken });
    const matId = await crearMaterialPrueba(t);
    await t.run((ctx) => crearCapaImpl(ctx, {
      materialId: matId, kgOriginal: 100000, costoUnitario: 1, fechaEntrada: 1000,
      origen: 'entrada', entradaId: null, cierreTurnoId: null,
      origenTipo: 'entrada', origenId: 'setup', createdBy: adminId,
    }));
    // Solo 10m de 1000m objetivo → 1%, muy debajo del umbral por default (90%).
    await t.mutation(api.cierres.crearCierreTurno, {
      fecha: HOY, linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 10,
      caballetes105Pzas: 0, caballetes106Pzas: 0,
      consumoPorMaterial: [{ materialId: matId, kgConsumido: 10 }],
      token: operadorToken,
    });

    await t.mutation(internal.alertas.evaluarAlertas, {});
    const historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    expect(historial.find((h) => h.reglaSlug === 'produccion-baja')).toBeDefined();
  });

  test('entrada-sin-costear está desactivada por default en el seed real — no dispara aunque haya una entrada vieja pendiente', async () => {
    const t = convexTest(schema, modules);
    const { adminId } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await t.run((ctx) => ctx.db.insert('entradas', {
      fecha: '2000-01-01', materialId: matId, cantidadKg: 100, costoUnitario: null,
      proveedor: 'x', folio: 'x', estado: 'pendiente', capaId: null,
      registradoPor: adminId, costeadoPor: null, costeadoEn: null,
      editado: false, editadoPor: null, editadoEn: null, createdAt: Date.now(),
    }));
    await t.run((ctx) => ctx.db.insert('alertasReglas', {
      slug: 'entrada-sin-costear', nombre: 'x', descripcion: '', activa: false, umbral: 3, unidad: 'días',
      destinatariosRoles: ['compras'], canales: ['sistema'], updatedAt: Date.now(), updatedBy: null,
    }));

    await t.mutation(internal.alertas.evaluarAlertas, {});
    const historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    expect(historial.find((h) => h.reglaSlug === 'entrada-sin-costear')).toBeUndefined();
  });

  test('entrada-sin-costear dispara cuando está activa y la entrada supera el umbral de días', async () => {
    const t = convexTest(schema, modules);
    const { adminId } = await setup(t);
    const matId = await crearMaterialPrueba(t);
    await t.run((ctx) => ctx.db.insert('entradas', {
      fecha: '2000-01-01', materialId: matId, cantidadKg: 250, costoUnitario: null,
      proveedor: 'x', folio: 'x', estado: 'pendiente', capaId: null,
      registradoPor: adminId, costeadoPor: null, costeadoEn: null,
      editado: false, editadoPor: null, editadoEn: null, createdAt: Date.now(),
    }));
    await t.run((ctx) => ctx.db.insert('alertasReglas', {
      slug: 'entrada-sin-costear', nombre: 'x', descripcion: '', activa: true, umbral: 3, unidad: 'días',
      destinatariosRoles: ['compras'], canales: ['sistema'], updatedAt: Date.now(), updatedBy: null,
    }));

    await t.mutation(internal.alertas.evaluarAlertas, {});
    const historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
    const alerta = historial.find((h) => h.reglaSlug === 'entrada-sin-costear');
    expect(alerta).toBeDefined();
    expect(alerta?.detalle).toMatch(/250/);
  });

  describe('turno-sin-cerrar — requiere hora de reloj controlada', () => {
    test('dispara para un turno de un día laboral cuya ventana + gracia ya pasó y no tiene cierresTurno', async () => {
      const t = convexTest(schema, modules);
      await setup(t);
      // 2026-08-11 19:00 hora local México (martes, día laboral) — 1h después
      // del fin del Turno 1 (18:00) + los 30 min de gracia por default.
      const fakeNow = horaLocalAInstante('2026-08-11', '19:00', ZONA);
      vi.useFakeTimers();
      vi.setSystemTime(fakeNow);

      await t.mutation(internal.alertas.evaluarAlertas, {});
      const historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
      const alerta = historial.find((h) => h.reglaSlug === 'turno-sin-cerrar' && h.detalle.includes('Turno 1'));
      expect(alerta).toBeDefined();
      expect(alerta?.detalle).toMatch(/2026-08-11/);
    });

    test('NO dispara si el cierre de ese turno ya existe', async () => {
      const t = convexTest(schema, modules);
      await setup(t);

      // La sesión se crea DESPUÉS de fijar la hora falsa — si no, su
      // expiresAt (calculado con la hora REAL) quedaría en el pasado en
      // cuanto adelantamos el reloj, y crearCierreTurno fallaría con
      // "sesión expirada" en vez de probar lo que este test busca probar.
      const fakeNow = horaLocalAInstante('2026-08-11', '19:00', ZONA);
      vi.useFakeTimers();
      vi.setSystemTime(fakeNow);

      const operadorId = await crearUsuarioPrueba(t, 'operador');
      const operadorToken = await crearSesionPrueba(t, operadorId);

      await t.mutation(api.cierres.crearCierreTurno, {
        fecha: '2026-08-11', linea: 1, turno: 1, cargasPreparadas: 1, metrosBuenos: 1,
        caballetes105Pzas: 0, caballetes106Pzas: 0, consumoPorMaterial: [], token: operadorToken,
      });

      await t.mutation(internal.alertas.evaluarAlertas, {});
      const historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
      expect(historial.find((h) => h.reglaSlug === 'turno-sin-cerrar' && h.detalle.includes('L1T1-2026-08-11'))).toBeUndefined();
    });

    test('NO dispara para un turno que pertenece a un día NO laboral (fin de semana)', async () => {
      const t = convexTest(schema, modules);
      await setup(t);
      // 2026-08-10 es lunes — el Turno 2 de "ayer" (2026-08-09, domingo) ya
      // debería estar cerrado, pero domingo no es día laboral: no debe disparar.
      const fakeNow = horaLocalAInstante('2026-08-10', '07:00', ZONA);
      vi.useFakeTimers();
      vi.setSystemTime(fakeNow);

      await t.mutation(internal.alertas.evaluarAlertas, {});
      const historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
      expect(historial.find((h) => h.reglaSlug === 'turno-sin-cerrar' && h.detalle.includes('2026-08-09'))).toBeUndefined();
    });

    test('NO dispara todavía si la ventana + gracia no ha pasado', async () => {
      const t = convexTest(schema, modules);
      await setup(t);
      // 2026-08-11 18:10 local — Turno 1 terminó a las 18:00, solo 10 min
      // después, por debajo de los 30 min de gracia por default.
      const fakeNow = horaLocalAInstante('2026-08-11', '18:10', ZONA);
      vi.useFakeTimers();
      vi.setSystemTime(fakeNow);

      await t.mutation(internal.alertas.evaluarAlertas, {});
      const historial = await t.run((ctx) => ctx.db.query('alertasHistorial').collect());
      expect(historial.find((h) => h.reglaSlug === 'turno-sin-cerrar' && h.detalle.includes('L1T1-2026-08-11'))).toBeUndefined();
    });
  });
});
