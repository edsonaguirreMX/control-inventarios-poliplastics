import { v, ConvexError } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import { requireAcceso } from './lib/auth';
import { requireParametros, ROLES_DASHBOARD } from './dashboard';
import { fechaOperativa, sumarDiasISO, horaLocalAInstante } from './lib/fechaOperativa';

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const CORREO_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Notificación in-app (campana) de que hay un reporte nuevo listo — se
// inserta en alertasHistorial (mismo mecanismo de 7.1) con un reglaSlug
// sintético que no corresponde a ninguna de las 7 alertasReglas
// configurables; alertas.ts la reconoce por nombre (NOMBRES_SISTEMA) y
// panel-control.html la reconoce para ofrecer el enlace de impresión, en
// vez de solo marcarla leída como el resto de las alertas. Sin esto, el
// cron generaba el reporte "en silencio" — nadie se enteraba salvo que un
// admin entrara a revisar el historial de Reporte Diario a mano (hallazgo
// bloqueante de la auditoría de PR 6).
const REGLA_SLUG_REPORTE = 'reporte-diario-generado';
async function crearNotificacionReporte(ctx: MutationCtx, hoy: string, ahoraMs: number, generadoPor: 'cron' | 'manual'): Promise<void> {
  await ctx.db.insert('alertasHistorial', {
    reglaSlug: REGLA_SLUG_REPORTE,
    fecha: ahoraMs,
    detalle: `Reporte diario del ${hoy} listo — abre el enlace para ver la vista de impresión del Panel de Control.`,
    // Único por invocación (no necesita dedupe propio: generarReporteDiario
    // ya garantiza como máximo una llamada por día operativo, y una
    // generación manual siempre debe notificar de nuevo).
    dedupeKey: `${REGLA_SLUG_REPORTE}:${generadoPor}:${ahoraMs}`,
    destinatariosRoles: [...ROLES_DASHBOARD],
    canales: ['sistema'],
  });
}

// Reporte Diario — pantalla admin-only. v1 solo genera un registro de
// historial in-app con el enlace de impresión de Panel de Control
// (?autoprint=1, ya conectado desde PR 4); correos/whatsapp se CAPTURAN
// para uso futuro (icebox I.1) pero no se envían de verdad todavía — la
// UI debe dejarlo explícito para no prometer un envío que no ocurre.
export const getConfig = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAcceso(ctx, token, 'reporte-diario');
    const config = await ctx.db.query('reporteDiarioConfig').first();
    return config ?? { hora: '14:00', activo: false, correos: [] as string[], whatsapp: [] as string[] };
  },
});

export const guardarConfig = mutation({
  args: {
    hora: v.string(),
    activo: v.boolean(),
    correos: v.array(v.string()),
    whatsapp: v.array(v.string()),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireAcceso(ctx, args.token, 'reporte-diario');
    if (!HORA_REGEX.test(args.hora)) {
      throw new ConvexError('guardarConfig: hora inválida — formato esperado HH:MM.');
    }
    for (const correo of args.correos) {
      if (!CORREO_REGEX.test(correo)) {
        throw new ConvexError(`guardarConfig: "${correo}" no parece un correo válido.`);
      }
    }
    const now = Date.now();
    const existente = await ctx.db.query('reporteDiarioConfig').first();
    const datos = {
      hora: args.hora, activo: args.activo, correos: args.correos, whatsapp: args.whatsapp,
      updatedAt: now, updatedBy: user._id,
    };
    if (existente) {
      await ctx.db.patch(existente._id, datos);
    } else {
      await ctx.db.insert('reporteDiarioConfig', datos);
    }
    return { ok: true };
  },
});

export const listHistorial = query({
  args: { token: v.string(), limite: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAcceso(ctx, args.token, 'reporte-diario');
    const limite = args.limite ?? 30;
    return ctx.db.query('reporteDiarioHistorial').order('desc').take(limite);
  },
});

// Botón "Generar y enviar ahora" — inserta un registro de historial de
// inmediato (generadoPor:"manual"), SIN deduplicar contra el cron: es una
// acción humana explícita, puede haber varias en un mismo día operativo
// (a diferencia del cron, que sí debe disparar como máximo una vez).
// destinatariosCount solo refleja cuántos hay configurados — correo/
// WhatsApp no se envían de verdad en v1 (ver comentario de arriba). Mismo
// flujo que el cron: también notifica por la campana (crearNotificacionReporte).
export const generarReporteAhora = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireAcceso(ctx, args.token, 'reporte-diario');
    const params = await requireParametros(ctx);
    const ahoraMs = Date.now();
    const hoy = fechaOperativa(ahoraMs, params.zonaHoraria, params.horaInicioTurno1);
    const config = await ctx.db.query('reporteDiarioConfig').first();
    const destinatariosCount = (config?.correos.length ?? 0) + (config?.whatsapp.length ?? 0);
    await ctx.db.insert('reporteDiarioHistorial', {
      fecha: ahoraMs, estado: 'generado', destinatariosCount, detalleError: null, generadoPor: 'manual',
    });
    await crearNotificacionReporte(ctx, hoy, ahoraMs, 'manual');
    return { ok: true };
  },
});

// Cron (ver crons.ts) — dispara como máximo UNA vez por día operativo,
// solo después de que pasó la hora configurada, sin importar cuántas veces
// corra el cron ese día: verifica que no exista ya un registro
// generadoPor:"cron" dentro del rango exacto de instantes del día
// operativo actual (calculado con horaLocalAInstante, no con medianoche
// UTC — mismo criterio que el resto del proyecto para "hoy").
export const generarReporteDiario = internalMutation({
  args: {},
  handler: async (ctx) => {
    const params = await requireParametros(ctx);
    const config = await ctx.db.query('reporteDiarioConfig').first();
    if (!config || !config.activo) return; // reporte desactivado — nada que hacer

    const ahoraMs = Date.now();
    const hoy = fechaOperativa(ahoraMs, params.zonaHoraria, params.horaInicioTurno1);
    const instanteEnvio = horaLocalAInstante(hoy, config.hora, params.zonaHoraria);
    if (ahoraMs < instanteEnvio) return; // todavía no es la hora configurada

    const inicioHoyMs = horaLocalAInstante(hoy, params.horaInicioTurno1, params.zonaHoraria);
    const finHoyMs = horaLocalAInstante(sumarDiasISO(hoy, 1), params.horaInicioTurno1, params.zonaHoraria);
    const historialHoy = await ctx.db
      .query('reporteDiarioHistorial')
      .withIndex('by_fecha', (q) => q.gte('fecha', inicioHoyMs).lt('fecha', finHoyMs))
      .collect();
    if (historialHoy.some((h) => h.generadoPor === 'cron')) return; // ya se generó hoy por cron

    const destinatariosCount = config.correos.length + config.whatsapp.length;
    await ctx.db.insert('reporteDiarioHistorial', {
      fecha: ahoraMs, estado: 'generado', destinatariosCount, detalleError: null, generadoPor: 'cron',
    });
    await crearNotificacionReporte(ctx, hoy, ahoraMs, 'cron');
  },
});
