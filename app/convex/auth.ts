import { v } from 'convex/values';
import { mutation, query, internalMutation, internalQuery } from './_generated/server';
import { requireUser } from './lib/auth';

// Runtime normal (no "use node") — necesario porque logout/me hacen
// ctx.db.* directo y solo actions pueden usar el runtime Node. El hashing
// de contraseña (que sí necesita Node/bcryptjs) vive en authActions.ts;
// esas dos internal functions de aquí son el puente que usa esa action.

const SESSION_MS_REMEMBER = 30 * 24 * 60 * 60 * 1000; // 30 días — "recordar en este dispositivo"
const SESSION_MS_DEFAULT = 12 * 60 * 60 * 1000; // 12 horas — aprox. un turno

// Rate limiting de login (EDS-70): 5 intentos fallidos en 15 minutos
// bloquean esa cuenta 15 minutos más. Por `usuario`, no por IP — ver nota
// en schema.ts.
const RATE_LIMIT_VENTANA_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_INTENTOS = 5;
const RATE_LIMIT_BLOQUEO_MS = 15 * 60 * 1000;

export const verificarRateLimitLogin = internalQuery({
  args: { usuario: v.string() },
  handler: async (ctx, { usuario }) => {
    const key = usuario.trim().toLowerCase();
    const registro = await ctx.db
      .query('loginIntentos')
      .withIndex('by_usuario', (q) => q.eq('usuario', key))
      .unique();
    if (!registro || !registro.bloqueadoHasta) return { bloqueado: false as const };
    if (registro.bloqueadoHasta <= Date.now()) return { bloqueado: false as const };
    return { bloqueado: true as const, hasta: registro.bloqueadoHasta };
  },
});

export const registrarIntentoFallidoLogin = internalMutation({
  args: { usuario: v.string() },
  handler: async (ctx, { usuario }) => {
    const key = usuario.trim().toLowerCase();
    const now = Date.now();
    const registro = await ctx.db
      .query('loginIntentos')
      .withIndex('by_usuario', (q) => q.eq('usuario', key))
      .unique();
    if (!registro) {
      await ctx.db.insert('loginIntentos', { usuario: key, intentos: 1, primerIntentoEn: now, bloqueadoHasta: null });
      return;
    }
    // Ventana deslizante: si el primer intento registrado ya expiró, se
    // reinicia el conteo en vez de acumular indefinidamente (evita que un
    // intento fallido aislado hace meses siga contando hoy).
    const dentroDeVentana = now - registro.primerIntentoEn < RATE_LIMIT_VENTANA_MS;
    const intentos = dentroDeVentana ? registro.intentos + 1 : 1;
    const primerIntentoEn = dentroDeVentana ? registro.primerIntentoEn : now;
    const bloqueadoHasta = intentos >= RATE_LIMIT_MAX_INTENTOS ? now + RATE_LIMIT_BLOQUEO_MS : null;
    await ctx.db.patch(registro._id, { intentos, primerIntentoEn, bloqueadoHasta });
  },
});

// Llamado tras un login exitoso — un login correcto es la señal más
// confiable de que la cuenta no está bajo ataque, así que limpia el
// contador en vez de dejarlo acumulado para el siguiente intento fallido
// legítimo (usuario que se equivoca de tecla una vez, meses después).
export const limpiarIntentosLogin = internalMutation({
  args: { usuario: v.string() },
  handler: async (ctx, { usuario }) => {
    const key = usuario.trim().toLowerCase();
    const registro = await ctx.db
      .query('loginIntentos')
      .withIndex('by_usuario', (q) => q.eq('usuario', key))
      .unique();
    if (registro) await ctx.db.delete(registro._id);
  },
});

export const getUserByUsuario = internalQuery({
  args: { usuario: v.string() },
  handler: async (ctx, { usuario }) => {
    return await ctx.db
      .query('users')
      .withIndex('by_usuario', (q) => q.eq('usuario', usuario.trim().toLowerCase()))
      .unique();
  },
});

export const createSession = internalMutation({
  args: { userId: v.id('users'), remember: v.boolean() },
  handler: async (ctx, { userId, remember }) => {
    const token = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + (remember ? SESSION_MS_REMEMBER : SESSION_MS_DEFAULT);
    await ctx.db.insert('sessions', { userId, token, createdAt: now, expiresAt, remember });
    return { token, expiresAt };
  },
});

export const logout = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const session = await ctx.db
      .query('sessions')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique();
    if (session) {
      await ctx.db.delete(session._id);
    }
    return { ok: true };
  },
});

export const me = query({
  args: { token: v.union(v.string(), v.null()) },
  handler: async (ctx, { token }) => {
    if (!token) return null;
    try {
      const user = await requireUser(ctx, token);
      // _id (inmutable) incluido junto a los campos editables — gestion-usuarios.html
      // lo usa para detectar "esta fila es mi propia cuenta" de forma estable aunque
      // yo mismo me haya renombrado el `usuario` en la misma sesión (hallazgo de
      // CodeRabbit en PR7: comparar por `usuario` se rompe si cambia a medio camino).
      return { _id: user._id, nombre: user.nombre, usuario: user.usuario, rol: user.rol };
    } catch {
      return null;
    }
  },
});
