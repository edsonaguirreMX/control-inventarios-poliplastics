// Utilidades compartidas por los archivos *.test.ts — no es un archivo de
// prueba en sí (sin describe/test), así que vitest no lo recoge como suite.
import type { TestConvex } from 'convex-test';
import type { GenericSchema, SchemaDefinition } from 'convex/server';

type AnyTestConvex = TestConvex<SchemaDefinition<GenericSchema, boolean>>;

export async function crearMaterialPrueba(
  t: AnyTestConvex,
  overrides: Partial<{
    slug: string;
    nombre: string;
    esInterno: boolean;
    esSustituto: boolean;
    activo: boolean;
    costoEstandar: number;
    leadTimeDias: number | null;
    stockSeguridadDias: number | null;
    reorderMode: 'auto' | 'manual';
    reorderManualKg: number | null;
    cantidadPedirKg: number | null;
  }> = {}
) {
  return t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert('materiales', {
      slug: overrides.slug ?? `test-${Math.random().toString(36).slice(2)}`,
      nombre: overrides.nombre ?? 'Material de prueba',
      variante: 'temporal',
      esInterno: overrides.esInterno ?? false,
      esSustituto: overrides.esSustituto ?? false,
      costoEstandar: overrides.costoEstandar ?? 1,
      leadTimeDias: overrides.leadTimeDias ?? 1,
      stockSeguridadDias: overrides.stockSeguridadDias ?? 1,
      reorderMode: overrides.reorderMode ?? 'auto',
      reorderManualKg: overrides.reorderManualKg ?? null,
      cantidadPedirKg: overrides.cantidadPedirKg ?? null,
      orden: 999,
      activo: overrides.activo ?? true,
      updatedAt: now,
      updatedBy: null,
    });
  });
}

export async function crearUsuarioPrueba(
  t: AnyTestConvex,
  rol: 'operador' | 'admin' | 'compras' | 'gerencia' | 'calidad',
  usuarioOverride?: string
) {
  return t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert('users', {
      nombre: `Test ${rol}`,
      usuario: usuarioOverride ?? `test.${rol}.${Math.random().toString(36).slice(2)}`,
      passwordHash: 'no-se-usa-en-estas-pruebas',
      rol,
      activo: true,
      createdAt: now,
      updatedAt: now,
    });
  });
}

// Crea una sesión válida directamente (sin pasar por login/bcrypt) y
// devuelve su token, para probar mutations/queries públicas que exigen
// `token` sin depender del flujo de auth completo (eso ya lo cubre Épica 1).
export async function crearSesionPrueba(t: AnyTestConvex, userId: any) {
  const token = `test-token-${Math.random().toString(36).slice(2)}`;
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert('sessions', { userId, token, createdAt: now, expiresAt: now + 3600_000, remember: false });
  });
  return token;
}

// lineasActivas se omite por default a propósito (no un default de 2
// aquí) — así los tests que no lo pasan siguen probando el mismo caso
// real de producción: un documento existente sin este campo (EDS-88 lo
// agregó como v.optional, no con una migración), que el código debe
// tratar como `?? 2`.
export async function crearParametrosPrueba(t: AnyTestConvex, kgPorMetro = 4, lineasActivas?: number) {
  return t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert('parametrosProduccion', {
      cargasPorTurno: 8,
      turnosPorDia: 2,
      ...(lineasActivas !== undefined ? { lineasActivas } : {}),
      kgPorMetro,
      horaInicioTurno1: '06:00',
      horaInicioTurno2: '18:00',
      diasLaborales: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
      minutosGraciaCierre: 60,
      zonaHoraria: 'America/Mexico_City',
      updatedAt: now,
      updatedBy: null,
    });
  });
}

// Siembra las mismas 7 reglas de alerta reales del seed de producción
// (importadas de seedData.ts, no duplicadas) — evaluarAlertas (7.2) las
// necesita para saber qué evaluar; convex-test arranca con las tablas
// vacías, no corre seed.ts automáticamente.
export async function crearReglasAlertaPrueba(t: AnyTestConvex) {
  const { ALERTAS_REGLAS } = await import('./seedData');
  return t.run(async (ctx) => {
    const now = Date.now();
    for (const r of ALERTAS_REGLAS) {
      await ctx.db.insert('alertasReglas', {
        slug: r.slug, nombre: r.nombre, descripcion: r.descripcion, activa: r.activa,
        umbral: r.umbral, unidad: r.unidad, destinatariosRoles: r.destinatariosRoles,
        canales: [...r.canales], updatedAt: now, updatedBy: null,
      });
    }
  });
}

export async function crearCierreDummy(t: AnyTestConvex, capturadoPor: any) {
  return t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert('cierresTurno', {
      fecha: '2000-01-01', linea: 1, turno: 1, cargasPreparadas: 0, metrosBuenos: 0,
      caballetes105Pzas: 0, caballetes106Pzas: 0, kgBuenos: 0, caballetesKg: 0, mermaTotalKg: 0,
      trituradoKg: 0, costoTotalConsumido: 0, costoRealPorKg: 0, costoRealPorMetro: 0,
      capturadoPor, capturadoEn: now, editado: false, editadoPor: null, editadoEn: null,
      vecesRecapturado: 0,
    });
  });
}

export async function getCapa(t: AnyTestConvex, capaId: any) {
  return t.run(async (ctx) => ctx.db.get(capaId));
}

export async function getMovimientos(t: AnyTestConvex, capaId: any) {
  return t.run(async (ctx) =>
    ctx.db.query('capaMovimientos').withIndex('by_capaId', (q: any) => q.eq('capaId', capaId)).collect()
  );
}
