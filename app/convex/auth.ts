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

// EDS-70 endurecido (bloqueante de la auditoría de PR8): la versión
// original separaba "checar si está bloqueado" (query de lectura) de
// "registrar el fallo" (mutation, llamada DESPUÉS de bcrypt). Bajo
// intentos concurrentes, varias llamadas a login() podían leer el mismo
// estado "no bloqueado" ANTES de que ninguna registrara su fallo — cada
// una corría bcrypt igual, y el límite de 5 no se respetaba bajo fuerza
// bruta en paralelo (el conteo final en la tabla terminaba correcto,
// porque Convex serializa mutations, pero el GATE que debía evitar correr
// bcrypt de más ya se había pasado de largo en todas).
//
// Fix: una sola mutation atómica que checa Y reserva el intento en la
// MISMA transacción, ANTES de tocar getUserByUsuario/bcrypt. Convex
// serializa mutations sobre el mismo documento (OCC) — así que aunque
// login() se llame muchas veces en paralelo, cada llamada a esta mutation
// se ejecuta una tras otra contra el estado ya actualizado por la
// anterior, nunca dos leyendo el mismo estado "todavía no bloqueado" a la
// vez. El intento se cuenta aquí SIEMPRE que se admite (incluso si termina
// siendo la contraseña correcta) — limpiarIntentosLogin deshace eso en el
// camino de éxito.
export const admitirIntentoLogin = internalMutation({
  args: { usuario: v.string() },
  handler: async (ctx, { usuario }): Promise<{ admitido: boolean }> => {
    const key = usuario.trim().toLowerCase();
    const now = Date.now();
    const registro = await ctx.db
      .query('loginIntentos')
      .withIndex('by_usuario', (q) => q.eq('usuario', key))
      .unique();

    // Ya bloqueado de una ronda anterior de intentos — rechaza sin siquiera
    // contar este como uno nuevo (no extiende el bloqueo de más).
    if (registro?.bloqueadoHasta && registro.bloqueadoHasta > now) {
      return { admitido: false };
    }

    if (!registro) {
      await ctx.db.insert('loginIntentos', {
        usuario: key, intentos: 1, primerIntentoEn: now, bloqueadoHasta: null,
        expiresAt: now + RATE_LIMIT_VENTANA_MS,
      });
      return { admitido: true };
    }

    // Ventana deslizante: si el primer intento registrado ya expiró, se
    // reinicia el conteo en vez de acumular indefinidamente.
    const dentroDeVentana = now - registro.primerIntentoEn < RATE_LIMIT_VENTANA_MS;
    const intentos = dentroDeVentana ? registro.intentos + 1 : 1;
    const primerIntentoEn = dentroDeVentana ? registro.primerIntentoEn : now;
    const bloqueadoHasta = intentos > RATE_LIMIT_MAX_INTENTOS ? now + RATE_LIMIT_BLOQUEO_MS : null;
    const expiresAt = (bloqueadoHasta ?? primerIntentoEn + RATE_LIMIT_VENTANA_MS);
    await ctx.db.patch(registro._id, { intentos, primerIntentoEn, bloqueadoHasta, expiresAt });

    // El intento que cruza el umbral (el 6º) ya no se admite — los
    // primeros 5 sí, incluso el que deja bloqueados a los siguientes.
    return { admitido: intentos <= RATE_LIMIT_MAX_INTENTOS };
  },
});

// Cron acotado (crons.ts) — sin esto, loginIntentos crece sin límite: cada
// usuario (real o inventado, probado por un atacante) que alguna vez
// falló un login deja una fila que nunca se borra sola, aunque su ventana
// ya haya expirado hace tiempo (mayor de la auditoría de PR8). `.take(200)`
// por corrida evita que una tabla ya grande vuelva lenta esta limpieza
// misma; corre cada hora, así que sobrantes de una corrida se limpian en
// la siguiente sin acumular indefinidamente.
export const limpiarLoginIntentosExpirados = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expirados = await ctx.db
      .query('loginIntentos')
      .withIndex('by_expiresAt', (q) => q.lt('expiresAt', now))
      .take(200);
    for (const registro of expirados) {
      await ctx.db.delete(registro._id);
    }
    return { borrados: expirados.length };
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
