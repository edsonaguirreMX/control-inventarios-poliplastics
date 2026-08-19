import { v } from 'convex/values';
import { mutation, query, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { requireUser } from './lib/auth';
import { PAGINAS } from './lib/paginas';
import { VISTAS_PANEL } from './lib/vistasPanel';

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
// misma.
//
// Endurecido (mayor de la re-review de CodeRabbit sobre el commit
// ae8d49b): un atacante que manda >200 usuarios distintos por hora crea
// filas más rápido de lo que el cron horario las limpia — el rezago podría
// crecer sin límite igual. Continuación: si este lote salió lleno (había
// ≥200 filas expiradas esperando), se reprograma para correr de inmediato
// en vez de esperar la próxima hora, así la limpieza le sigue el paso a un
// flood mientras dure, en vez de quedar fija en 200/hora. (No sustituye un
// throttling por IP/cliente — esta app no tiene esa señal por diseño, ver
// nota arriba; el flood en sí sigue siendo posible, esto solo evita que su
// rezago se acumule indefinidamente.)
export const limpiarLoginIntentosExpirados = internalMutation({
  args: {},
  handler: async (ctx) => {
    const LOTE = 200;
    const now = Date.now();
    const expirados = await ctx.db
      .query('loginIntentos')
      .withIndex('by_expiresAt', (q) => q.lt('expiresAt', now))
      .take(LOTE);
    for (const registro of expirados) {
      await ctx.db.delete(registro._id);
    }
    if (expirados.length === LOTE) {
      await ctx.scheduler.runAfter(0, internal.auth.limpiarLoginIntentosExpirados, {});
    }
    return { borrados: expirados.length };
  },
});

// Llamado tras un login exitoso.
//
// Endurecido (mayor de la re-review de CodeRabbit sobre el commit
// ae8d49b, mismo punto que ya había pedido en la ronda anterior): la
// versión previa borraba la fila COMPLETA de loginIntentos al primer
// login exitoso. Bajo intentos concurrentes eso es un problema real: si
// un login legítimo (o del propio atacante adivinando bien al final)
// resuelve mientras OTROS intentos fallidos del mismo usuario siguen en
// vuelo (ya admitidos por admitirIntentoLogin, contados en `intentos`,
// pero su bcrypt todavía no resuelve), borrar toda la fila también borra
// las reservas de esos otros intentos — el atacante recupera un cupo
// completo de 5 intentos nuevos de la nada.
//
// Fix: decrementar en 1 (deshacer SOLO la reserva propia de este login
// exitoso), no borrar todo. Si el contador llega a 0 (nadie más tiene una
// reserva en vuelo), ahí sí se borra la fila entera — mismo resultado que
// antes para el caso común (un solo login exitoso sin nada concurrente).
// Si el contador ya cruzó el umbral y quedó bloqueado (bloqueadoHasta
// seteado) por los OTROS intentos, ese bloqueo se deja intacto: es una
// ventana de tiempo, no algo que un login exitoso concurrente deba anular.
export const limpiarIntentosLogin = internalMutation({
  args: { usuario: v.string() },
  handler: async (ctx, { usuario }) => {
    const key = usuario.trim().toLowerCase();
    const registro = await ctx.db
      .query('loginIntentos')
      .withIndex('by_usuario', (q) => q.eq('usuario', key))
      .unique();
    if (!registro) return;
    if (registro.intentos <= 1) {
      await ctx.db.delete(registro._id);
      return;
    }
    await ctx.db.patch(registro._id, { intentos: registro.intentos - 1 });
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
      // EDS-106 (Fase 3 de EDS-103): rolNombre/paginasPermitidas resueltos
      // aquí, contra la tabla `roles` — el frontend (session.js::requireAcceso)
      // ya no necesita conocer el catálogo de páginas ni las reglas de
      // bypass/activo, solo comparar la página que pide contra este arreglo.
      // Si el rol del usuario no existe o está inactivo en `roles` (mismo
      // caso que bloquea requireAcceso en el backend), paginasPermitidas
      // queda vacío — el usuario sigue "logueado" (me no lanza) pero
      // requireAcceso() del frontend lo redirige a login en cualquier
      // pantalla protegida, igual que ya le pasaría en cualquier llamada
      // real al backend.
      const rol = await ctx.db
        .query('roles')
        .withIndex('by_slug', (q) => q.eq('slug', user.rol))
        .unique();
      const rolActivo = rol?.activo ?? false;
      const rolNombre = rol?.nombre ?? user.rol;
      const paginasPermitidas = rolActivo ? (rol!.bypassAcceso ? [...PAGINAS] : rol!.paginas) : [];
      // EDS-111: mismo criterio que paginasPermitidas, pero para las
      // vistas internas de Panel de Control (Compras/Calidad/Gerencia) —
      // bypass (admin) ve las 3, rol inactivo no ve ninguna. `?? []`
      // porque vistasPanel es opcional en el schema (roles sembrados
      // antes de EDS-111 no lo tienen todavía).
      const vistasPanel = rolActivo ? (rol!.bypassAcceso ? [...VISTAS_PANEL] : (rol!.vistasPanel ?? [])) : [];
      // _id (inmutable) incluido junto a los campos editables — gestion-usuarios.html
      // lo usa para detectar "esta fila es mi propia cuenta" de forma estable aunque
      // yo mismo me haya renombrado el `usuario` en la misma sesión (hallazgo de
      // CodeRabbit en PR7: comparar por `usuario` se rompe si cambia a medio camino).
      return {
        _id: user._id, nombre: user.nombre, usuario: user.usuario, rol: user.rol,
        rolNombre, paginasPermitidas, vistasPanel,
      };
    } catch {
      return null;
    }
  },
});
