import { v } from 'convex/values';
import { mutation, query, internalMutation, internalQuery } from './_generated/server';
import { requireUser } from './lib/auth';

// Runtime normal (no "use node") — necesario porque logout/me hacen
// ctx.db.* directo y solo actions pueden usar el runtime Node. El hashing
// de contraseña (que sí necesita Node/bcryptjs) vive en authActions.ts;
// esas dos internal functions de aquí son el puente que usa esa action.

const SESSION_MS_REMEMBER = 30 * 24 * 60 * 60 * 1000; // 30 días — "recordar en este dispositivo"
const SESSION_MS_DEFAULT = 12 * 60 * 60 * 1000; // 12 horas — aprox. un turno

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
