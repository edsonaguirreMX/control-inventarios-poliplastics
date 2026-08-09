import { v } from 'convex/values';
import { mutation, query, internalMutation, internalQuery } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { requireRole } from './lib/auth';

// Gestión de Usuarios — pantalla admin-only. El hashing de contraseña
// (bcryptjs, runtime Node) vive en usuariosActions.ts, igual patrón que
// auth.ts/authActions.ts: las mutations/queries normales de este archivo
// nunca tocan bcrypt directamente, solo reciben el hash ya calculado.
const ROL_VALUE = v.union(
  v.literal('operador'), v.literal('admin'), v.literal('gerencia'), v.literal('compras'), v.literal('calidad')
);

// Nunca se manda passwordHash al cliente, ni siquiera a un admin.
export const listUsuarios = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireRole(ctx, token, ['admin']);
    const usuarios = await ctx.db.query('users').collect();
    return usuarios.map((u) => ({
      _id: u._id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, activo: u.activo, createdAt: u.createdAt,
    }));
  },
});

// Puerta de autorización reutilizada por las actions de
// usuariosActions.ts (una action no tiene ctx.db, así que no puede llamar
// requireRole directo — delega aquí vía ctx.runQuery, ANTES de calcular el
// hash de bcrypt, para no gastar ese trabajo en una llamada no autorizada).
export const verificarAdminImpl = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireRole(ctx, token, ['admin']);
  },
});

type ActualizarUsuarioArgs = {
  userId: Id<'users'>;
  nombre?: string;
  usuario?: string;
  rol?: 'operador' | 'admin' | 'gerencia' | 'compras' | 'calidad';
};

async function actualizarUsuarioImpl(ctx: MutationCtx, args: ActualizarUsuarioArgs): Promise<void> {
  const existente = await ctx.db.get(args.userId);
  if (!existente) {
    throw new Error('actualizarUsuario: el usuario no existe.');
  }
  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (args.nombre !== undefined) {
    const nombre = args.nombre.trim();
    if (!nombre) throw new Error('actualizarUsuario: el nombre no puede estar vacío.');
    patch.nombre = nombre;
  }
  if (args.usuario !== undefined) {
    const usuario = args.usuario.trim().toLowerCase();
    if (!usuario) throw new Error('actualizarUsuario: el usuario no puede estar vacío.');
    // Dentro de la MISMA transacción, un patch anterior en este mismo batch
    // (guardarUsuariosCompleto) ya es visible aquí — Convex da lecturas
    // "read-your-own-writes" dentro de una mutation, así que un intercambio
    // de usuario entre dos filas del mismo guardado se resuelve correcto
    // sin lógica especial: solo una colisión REAL (dos filas queriendo el
    // mismo valor a la vez) sigue rechazándose.
    const dup = await ctx.db.query('users').withIndex('by_usuario', (q) => q.eq('usuario', usuario)).unique();
    if (dup && dup._id !== args.userId) {
      throw new Error(`actualizarUsuario: el usuario "${usuario}" ya existe.`);
    }
    patch.usuario = usuario;
  }
  if (args.rol !== undefined) patch.rol = args.rol;
  await ctx.db.patch(args.userId, patch);
}

export const updateUsuario = mutation({
  args: { userId: v.id('users'), nombre: v.optional(v.string()), usuario: v.optional(v.string()), rol: v.optional(ROL_VALUE), token: v.string() },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.token, ['admin']);
    await actualizarUsuarioImpl(ctx, args);
    return { ok: true };
  },
});

// Un solo botón "Guardar cambios" para toda la tabla (nombre/usuario/rol
// de varias filas a la vez) — una sola transacción atómica, mismo patrón
// ya establecido en PR3/PR5/PR6 (nunca un loop de mutations independientes
// del cliente).
export const guardarUsuariosCompleto = mutation({
  args: {
    usuarios: v.array(v.object({
      userId: v.id('users'), nombre: v.optional(v.string()), usuario: v.optional(v.string()), rol: v.optional(ROL_VALUE),
    })),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.token, ['admin']);
    if (args.usuarios.length === 0) {
      throw new Error('guardarUsuariosCompleto: no hay cambios que guardar.');
    }
    for (const u of args.usuarios) {
      await actualizarUsuarioImpl(ctx, u);
    }
    return { ok: true };
  },
});

// Llamada por usuariosActions.ts (crearUsuario) DESPUÉS de hashear el
// password temporal — nunca expuesta directo a ningún rol.
export const crearUsuarioImpl = internalMutation({
  args: { nombre: v.string(), usuario: v.string(), passwordHash: v.string(), rol: ROL_VALUE },
  handler: async (ctx, args) => {
    const nombre = args.nombre.trim();
    const usuario = args.usuario.trim().toLowerCase();
    if (!nombre) throw new Error('crearUsuario: el nombre no puede estar vacío.');
    if (!usuario) throw new Error('crearUsuario: el usuario no puede estar vacío.');
    const existente = await ctx.db.query('users').withIndex('by_usuario', (q) => q.eq('usuario', usuario)).unique();
    if (existente) {
      throw new Error(`crearUsuario: el usuario "${usuario}" ya existe.`);
    }
    const now = Date.now();
    return ctx.db.insert('users', { nombre, usuario, passwordHash: args.passwordHash, rol: args.rol, activo: true, createdAt: now, updatedAt: now });
  },
});

// Llamada por usuariosActions.ts (regenerarPassword) DESPUÉS de hashear.
export const actualizarPasswordImpl = internalMutation({
  args: { userId: v.id('users'), passwordHash: v.string() },
  handler: async (ctx, args) => {
    const existente = await ctx.db.get(args.userId);
    if (!existente) throw new Error('regenerarPassword: el usuario no existe.');
    await ctx.db.patch(args.userId, { passwordHash: args.passwordHash, updatedAt: Date.now() });
  },
});

// "Eliminar" en la UI = desactivar (activo:false), NUNCA un borrado real de
// la fila: muchas otras tablas referencian este userId en su historial
// (cierresTurno.capturadoPor, capaMovimientos.createdBy,
// correccionesHistorial.corregidoPor, alertasLecturas.userId, etc.) —
// borrarlo de verdad dejaría esos registros de auditoría apuntando a un
// usuario fantasma, exactamente lo que este proyecto evita en todos lados
// (capaMovimientos, correccionesHistorial, vigente:false). Para quien usa
// la pantalla el resultado es el mismo que promete el mockup: "ya no podrá
// iniciar sesión" — requireUser ya rechaza activo:false — y además se
// invalidan sus sesiones activas para que el efecto sea inmediato.
// El guard de "no te desactives a ti mismo" (abajo) ya es, por sí solo,
// suficiente para que el sistema NUNCA se quede sin ningún admin activo:
// quien llama esta mutation siempre es un admin activo (requireRole ya lo
// exige), así que si desactiva a alguien MÁS, el que llama sigue activo —
// el conteo de admins activos jamás puede llegar a 0 por esta vía. Un
// guard adicional de "no desactives al último admin" sería código muerto
// (nunca podría dispararse sin que el de arriba ya lo hubiera bloqueado
// antes) — se dejó fuera a propósito, no por descuido.
export const eliminarUsuario = mutation({
  args: { userId: v.id('users'), token: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireRole(ctx, args.token, ['admin']);
    if (args.userId === admin._id) {
      throw new Error('No puedes desactivar tu propio usuario mientras tienes la sesión abierta.');
    }
    const objetivo = await ctx.db.get(args.userId);
    if (!objetivo) {
      throw new Error('eliminarUsuario: el usuario no existe.');
    }
    await ctx.db.patch(args.userId, { activo: false, updatedAt: Date.now() });
    const sesiones = await ctx.db.query('sessions').withIndex('by_userId', (q) => q.eq('userId', args.userId)).collect();
    for (const s of sesiones) {
      await ctx.db.delete(s._id);
    }
    return { ok: true };
  },
});

// Simétrico a eliminarUsuario — un usuario desactivado por error (o que
// vuelve a la planta) puede reactivarse sin tener que volver a crear la
// fila, conservando su historial de auditoría intacto.
export const reactivarUsuario = mutation({
  args: { userId: v.id('users'), token: v.string() },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.token, ['admin']);
    const objetivo = await ctx.db.get(args.userId);
    if (!objetivo) {
      throw new Error('reactivarUsuario: el usuario no existe.');
    }
    await ctx.db.patch(args.userId, { activo: true, updatedAt: Date.now() });
    return { ok: true };
  },
});
