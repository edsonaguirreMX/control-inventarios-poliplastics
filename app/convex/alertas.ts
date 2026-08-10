import { v, ConvexError } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { requireRole } from './lib/auth';
import type { Rol } from './lib/auth';
import { fechaOperativa, sumarDiasISO, horaLocalAInstante, nombreDiaSemana } from './lib/fechaOperativa';
import { calcularKPIsHoyImpl, requireParametros, cierresEnRango } from './dashboard';

// Cualquier rol autenticado puede leer/marcar SUS PROPIAS alertas — la
// restricción real de "qué le llega a quién" vive en
// alertasReglas.destinatariosRoles, no en el guard de estas mutations.
const CUALQUIER_ROL: Rol[] = ['operador', 'admin', 'gerencia', 'compras', 'calidad'];

// Margen fijo usado también por panel-control.html (MERMA_META) para el
// estado "por vencer"/tendencia de merma — no hay una meta de merma
// persistida en el backend todavía (fuera del alcance de esta épica); se
// documenta aquí para que ambos números se muevan juntos si algún día cambia.
const META_MERMA_PCT = 5.0;

// Nombres legibles para reglaSlug que NO vienen de alertasReglas (no son
// una de las 7 reglas configurables) — hoy solo la notificación de Reporte
// Diario (reporteDiario.ts), que reutiliza este mismo mecanismo de
// alertasHistorial en vez de inventar una tabla de notificaciones aparte.
const NOMBRES_SISTEMA: Record<string, string> = {
  'reporte-diario-generado': 'Reporte diario generado',
};

/* ============================================================
   7.1 — CRUD de alertasReglas (admin-only) + lecturas por usuario
   ============================================================ */

export const listReglas = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireRole(ctx, token, ['admin']);
    return ctx.db.query('alertasReglas').collect();
  },
});

type ActualizarReglaArgs = {
  slug: string;
  activa?: boolean;
  umbral?: number | null;
  destinatariosRoles?: string[];
  canales?: ('correo' | 'whatsapp' | 'sistema')[];
};

async function actualizarReglaImpl(ctx: MutationCtx, user: { _id: Id<'users'> }, args: ActualizarReglaArgs): Promise<void> {
  const regla = await ctx.db.query('alertasReglas').withIndex('by_slug', (q) => q.eq('slug', args.slug)).unique();
  if (!regla) {
    throw new ConvexError(`actualizarRegla: no existe una regla con slug "${args.slug}".`);
  }
  if (args.destinatariosRoles !== undefined && args.destinatariosRoles.length === 0) {
    throw new ConvexError('actualizarRegla: una regla necesita al menos un destinatario.');
  }
  if (args.canales !== undefined && args.canales.length === 0) {
    throw new ConvexError('actualizarRegla: una regla necesita al menos un canal.');
  }
  const patch: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: user._id };
  if (args.activa !== undefined) patch.activa = args.activa;
  if (args.umbral !== undefined) patch.umbral = args.umbral;
  if (args.destinatariosRoles !== undefined) patch.destinatariosRoles = args.destinatariosRoles;
  if (args.canales !== undefined) patch.canales = args.canales;
  await ctx.db.patch(regla._id, patch);
}

const CANAL_VALUE = v.union(v.literal('correo'), v.literal('whatsapp'), v.literal('sistema'));

export const updateRegla = mutation({
  args: {
    slug: v.string(),
    activa: v.optional(v.boolean()),
    umbral: v.optional(v.union(v.number(), v.null())),
    destinatariosRoles: v.optional(v.array(v.string())),
    canales: v.optional(v.array(CANAL_VALUE)),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['admin']);
    await actualizarReglaImpl(ctx, user, args);
    return { ok: true };
  },
});

// La pantalla tiene un solo botón "Guardar cambios" para las 7 reglas —
// una sola transacción, nunca un loop de mutations independientes del
// cliente (mismo patrón ya establecido en PR 3/PR 5).
export const guardarReglasCompleto = mutation({
  args: {
    reglas: v.array(v.object({
      slug: v.string(),
      activa: v.optional(v.boolean()),
      umbral: v.optional(v.union(v.number(), v.null())),
      destinatariosRoles: v.optional(v.array(v.string())),
      canales: v.optional(v.array(CANAL_VALUE)),
    })),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['admin']);
    if (args.reglas.length === 0) {
      throw new ConvexError('guardarReglasCompleto: se necesita al menos una regla.');
    }
    for (const regla of args.reglas) {
      await actualizarReglaImpl(ctx, user, regla);
    }
    return { ok: true };
  },
});

async function noLeidasParaUsuarioImpl(ctx: QueryCtx, user: Doc<'users'>): Promise<Doc<'alertasHistorial'>[]> {
  // Ventana de 30 días: suficiente para "lo que sigue pendiente de leer"
  // sin traer todo el historial completo en cada carga de la campana.
  const desde = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const historial = await ctx.db.query('alertasHistorial').withIndex('by_fecha', (q) => q.gte('fecha', desde)).collect();
  const relevantes = historial.filter((h) => h.destinatariosRoles.includes(user.rol));
  const resultado: Doc<'alertasHistorial'>[] = [];
  for (const h of relevantes) {
    const leida = await ctx.db
      .query('alertasLecturas')
      .withIndex('by_alerta_user', (q) => q.eq('alertaId', h._id).eq('userId', user._id))
      .unique();
    if (!leida) resultado.push(h);
  }
  return resultado;
}

// Idempotente vía el índice compuesto by_alerta_user (no por convención):
// marcar dos veces la misma alerta del mismo usuario no inserta una
// segunda fila ni falla, solo no hace nada la segunda vez.
export const marcarAlertaLeida = mutation({
  args: { alertaId: v.id('alertasHistorial'), token: v.string() },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, CUALQUIER_ROL);
    const existente = await ctx.db
      .query('alertasLecturas')
      .withIndex('by_alerta_user', (q) => q.eq('alertaId', args.alertaId).eq('userId', user._id))
      .unique();
    if (existente) return { ok: true, yaEstaba: true };
    await ctx.db.insert('alertasLecturas', { alertaId: args.alertaId, userId: user._id, leidaEn: Date.now() });
    return { ok: true, yaEstaba: false };
  },
});

// Batch atómico para el botón "Marcar todas como leídas" — una sola
// transacción en vez de que el cliente loopee marcarAlertaLeida N veces.
export const marcarTodasLeidas = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, CUALQUIER_ROL);
    const noLeidas = await noLeidasParaUsuarioImpl(ctx, user);
    const now = Date.now();
    for (const alerta of noLeidas) {
      await ctx.db.insert('alertasLecturas', { alertaId: alerta._id, userId: user._id, leidaEn: now });
    }
    return { ok: true, marcadas: noLeidas.length };
  },
});

// Para la campana (7.4) — conteo y lista real de no leídas para el usuario
// de la sesión actual, filtradas por si su rol está en destinatariosRoles.
// Incluye el nombre de la regla (join con alertasReglas) porque la campana
// vive en panel-control.html, visible a roles que NO pueden llamar
// listReglas (admin-only) — así ningún rol necesita ese permiso solo para
// mostrar el nombre legible de sus propias alertas.
export const noLeidasParaMi = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await requireRole(ctx, token, CUALQUIER_ROL);
    const noLeidas = await noLeidasParaUsuarioImpl(ctx, user);
    const reglas = await ctx.db.query('alertasReglas').collect();
    const nombrePorSlug = new Map(reglas.map((r) => [r.slug, r.nombre]));
    return noLeidas
      .sort((a, b) => b.fecha - a.fecha)
      .map((h) => ({
        _id: h._id, reglaSlug: h.reglaSlug,
        nombreRegla: nombrePorSlug.get(h.reglaSlug) ?? NOMBRES_SISTEMA[h.reglaSlug] ?? h.reglaSlug,
        fecha: h.fecha, detalle: h.detalle, canales: h.canales,
      }));
  },
});

// Historial completo para la pantalla de configuración (admin-only, mismo
// guard que la página) — incluye si EL ADMIN QUE LO PIDE ya lo leyó.
export const listHistorial = query({
  args: { token: v.string(), limite: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['admin']);
    const limite = args.limite ?? 40;
    const historial = await ctx.db.query('alertasHistorial').order('desc').take(limite);
    const reglas = await ctx.db.query('alertasReglas').collect();
    const nombrePorSlug = new Map(reglas.map((r) => [r.slug, r.nombre]));
    const resultado = [];
    for (const h of historial) {
      const leida = await ctx.db
        .query('alertasLecturas')
        .withIndex('by_alerta_user', (q) => q.eq('alertaId', h._id).eq('userId', user._id))
        .unique();
      resultado.push({
        _id: h._id, reglaSlug: h.reglaSlug,
        nombreRegla: nombrePorSlug.get(h.reglaSlug) ?? NOMBRES_SISTEMA[h.reglaSlug] ?? h.reglaSlug,
        fecha: h.fecha, detalle: h.detalle,
        destinatariosRoles: h.destinatariosRoles, canales: h.canales, leida: !!leida,
      });
    }
    return resultado;
  },
});

/* ============================================================
   7.2 — Motor de evaluación (disparado por cron, ver crons.ts)
   ============================================================ */

// Lunes de la semana operativa a la que pertenece `fechaISO`, retrocediendo
// día por día (máximo 6 pasos) — más simple y menos propenso a error que
// aritmética de día-de-la-semana con offsets numéricos.
function lunesDeEstaSemana(fechaISO: string): string {
  let f = fechaISO;
  for (let i = 0; i < 7; i++) {
    if (nombreDiaSemana(f) === 'lunes') return f;
    f = sumarDiasISO(f, -1);
  }
  return f;
}

function diferenciaDiasISO(desdeISO: string, hastaISO: string): number {
  const [y1, m1, d1] = desdeISO.split('-').map(Number);
  const [y2, m2, d2] = hastaISO.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

const fmtKg = (n: number) => Math.round(n).toLocaleString('es-MX');

// Evalúa las 7 reglas contra datos reales y dispara (inserta en
// alertasHistorial) las que correspondan — con dedupe real vía
// alertasHistorial.by_dedupeKey (nunca dos alertas de la misma regla+
// entidad el mismo día operativo, sin importar cuántas veces corra el cron
// mientras tanto). Solo internalMutation: nunca expuesta a ningún rol
// directamente, solo la dispara el cron (o un test).
export const evaluarAlertas = internalMutation({
  args: {},
  handler: async (ctx) => {
    const params = await requireParametros(ctx);
    const ahoraMs = Date.now();
    const hoy = fechaOperativa(ahoraMs, params.zonaHoraria, params.horaInicioTurno1);
    const reglas = await ctx.db.query('alertasReglas').collect();
    const reglaPorSlug = new Map(reglas.map((r) => [r.slug, r]));

    async function disparar(regla: Doc<'alertasReglas'>, entidadKey: string, detalle: string): Promise<void> {
      const dedupeKey = `${regla.slug}:${entidadKey}:${hoy}`;
      const existente = await ctx.db.query('alertasHistorial').withIndex('by_dedupeKey', (q) => q.eq('dedupeKey', dedupeKey)).unique();
      if (existente) return;
      await ctx.db.insert('alertasHistorial', {
        reglaSlug: regla.slug, fecha: ahoraMs, detalle, dedupeKey,
        destinatariosRoles: regla.destinatariosRoles, canales: regla.canales,
      });
    }

    // --- turno-sin-cerrar ---
    const reglaTurno = reglaPorSlug.get('turno-sin-cerrar');
    if (reglaTurno?.activa) {
      const graciaMin = reglaTurno.umbral ?? 30;
      const ayer = sumarDiasISO(hoy, -1);
      // Turno 1 de hoy termina en horaInicioTurno2 de hoy; Turno 2 de AYER
      // termina en horaInicioTurno1 de HOY (cruza medianoche) — el mismo
      // criterio de fechaOperativa, aplicado al revés.
      const finTurno1Hoy = horaLocalAInstante(hoy, params.horaInicioTurno2, params.zonaHoraria);
      const finTurno2Ayer = horaLocalAInstante(hoy, params.horaInicioTurno1, params.zonaHoraria);
      const turnosARevisar: { fecha: string; linea: 1 | 2; turno: 1 | 2; finMs: number }[] = [];
      for (const linea of [1, 2] as const) {
        turnosARevisar.push({ fecha: hoy, linea, turno: 1, finMs: finTurno1Hoy });
        turnosARevisar.push({ fecha: ayer, linea, turno: 2, finMs: finTurno2Ayer });
      }
      for (const t of turnosARevisar) {
        if (!params.diasLaborales.includes(nombreDiaSemana(t.fecha))) continue;
        if (ahoraMs < t.finMs + graciaMin * 60_000) continue; // todavía no vence
        const existeCierre = await ctx.db
          .query('cierresTurno')
          .withIndex('by_fecha_linea_turno', (q) => q.eq('fecha', t.fecha).eq('linea', t.linea).eq('turno', t.turno))
          .unique();
        if (existeCierre) continue;
        await disparar(reglaTurno, `L${t.linea}T${t.turno}-${t.fecha}`, `Línea ${t.linea} · Turno ${t.turno} (${t.fecha}) sin cerrar ${graciaMin} min después de su fin.`);
      }
    }

    // --- material-critico / material-por-vencer / merma-alta / costo-alto (comparten calcularKPIsHoyImpl) ---
    const reglaCritico = reglaPorSlug.get('material-critico');
    const reglaPorVencer = reglaPorSlug.get('material-por-vencer');
    const reglaMerma = reglaPorSlug.get('merma-alta');
    const reglaCosto = reglaPorSlug.get('costo-alto');
    if (reglaCritico?.activa || reglaPorVencer?.activa || reglaMerma?.activa || reglaCosto?.activa) {
      const kpis = await calcularKPIsHoyImpl(ctx);

      for (const m of kpis.materiales) {
        if (m.reorderKg === null) continue; // sin punto de reorden (interno/sustituto)
        const nombreCompleto = m.variante ? `${m.nombre} (${m.variante})` : m.nombre;
        if (reglaCritico?.activa && m.existenciaKg < m.reorderKg) {
          await disparar(reglaCritico, m.materialId, `${nombreCompleto}: ${fmtKg(m.existenciaKg)} kg (bajo el punto de reorden de ${fmtKg(m.reorderKg)} kg).`);
          continue; // ya crítico — no evaluar "por vencer" para el mismo material el mismo día
        }
        if (reglaPorVencer?.activa) {
          const margenPct = reglaPorVencer.umbral ?? 15;
          const umbralPorVencer = m.reorderKg * (1 + margenPct / 100);
          if (m.existenciaKg < umbralPorVencer) {
            await disparar(reglaPorVencer, m.materialId, `${nombreCompleto}: ${fmtKg(m.existenciaKg)} kg — a menos de ${margenPct}% de su punto de reorden (${fmtKg(m.reorderKg)} kg).`);
          }
        }
      }

      if (reglaMerma?.activa) {
        const margenPp = reglaMerma.umbral ?? 1.0;
        if (kpis.pctMermaHoy > META_MERMA_PCT + margenPp) {
          await disparar(reglaMerma, '', `${kpis.pctMermaHoy.toFixed(1)}% vs. meta ${META_MERMA_PCT.toFixed(1)}%.`);
        }
      }

      if (reglaCosto?.activa && kpis.costoEstandarPorKg > 0) {
        const margenPct = reglaCosto.umbral ?? 5;
        if (kpis.costoRealPorKgHoy > kpis.costoEstandarPorKg * (1 + margenPct / 100)) {
          const deltaPct = ((kpis.costoRealPorKgHoy - kpis.costoEstandarPorKg) / kpis.costoEstandarPorKg) * 100;
          await disparar(reglaCosto, '', `+${deltaPct.toFixed(1)}% sobre estándar ($${kpis.costoRealPorKgHoy.toFixed(2)} vs $${kpis.costoEstandarPorKg.toFixed(2)}/kg).`);
        }
      }
    }

    // --- produccion-baja (independiente de calcularKPIsHoyImpl: usa objetivosProduccion + suma semanal) ---
    const reglaProdBaja = reglaPorSlug.get('produccion-baja');
    if (reglaProdBaja?.activa) {
      const objetivo = await ctx.db.query('objetivosProduccion').first();
      if (objetivo && objetivo.semana > 0) {
        const lunes = lunesDeEstaSemana(hoy);
        const diasTranscurridos = diferenciaDiasISO(lunes, hoy) + 1;
        const { cierres } = await cierresEnRango(ctx, diasTranscurridos);
        const metrosSemana = cierres.filter((c) => c.fecha >= lunes && c.fecha <= hoy).reduce((s, c) => s + c.metrosBuenos, 0);
        const pctSemana = (metrosSemana / objetivo.semana) * 100;
        const umbral = reglaProdBaja.umbral ?? 90;
        if (pctSemana < umbral) {
          await disparar(reglaProdBaja, '', `Producción acumulada de la semana: ${pctSemana.toFixed(0)}% del objetivo (${fmtKg(metrosSemana)} de ${fmtKg(objetivo.semana)} m).`);
        }
      }
    }

    // --- entrada-sin-costear (desactivada por default en el seed) ---
    const reglaEntrada = reglaPorSlug.get('entrada-sin-costear');
    if (reglaEntrada?.activa) {
      const umbralDias = reglaEntrada.umbral ?? 3;
      const pendientes = await ctx.db.query('entradas').withIndex('by_estado', (q) => q.eq('estado', 'pendiente')).collect();
      for (const entrada of pendientes) {
        const dias = diferenciaDiasISO(entrada.fecha, hoy);
        if (dias >= umbralDias) {
          const material = await ctx.db.get(entrada.materialId);
          await disparar(reglaEntrada, entrada._id, `${material?.nombre ?? 'Material'}, ${fmtKg(entrada.cantidadKg)} kg recibidos hace ${dias} día(s) sin costo unitario.`);
        }
      }
    }
  },
});
