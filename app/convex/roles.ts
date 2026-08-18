import { v, ConvexError } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { requireRole } from './lib/auth';
import { PAGINAS, PAGINAS_NO_CONFIGURABLES } from './lib/paginas';

// Gestión de Roles — pantalla admin-only (EDS-104, Fase 1 de la épica
// EDS-103, roles personalizables). A propósito se autoriza con el
// mecanismo VIEJO (requireRole(['admin'])), no con requireAcceso — evita
// un problema de huevo-gallina (esta pantalla administra QUIÉN tiene
// acceso a qué, no puede depender de sí misma para autorizarse). Mismo
// motivo por el que "gestion-usuarios" y "gestion-roles" están en
// PAGINAS_NO_CONFIGURABLES: un rol personalizable jamás debe poder
// auto-otorgarse esta pantalla y escalar sus propios privilegios.

function validarPaginas(paginas: string[]) {
  const validas = new Set<string>(PAGINAS);
  const noConfigurables = new Set<string>(PAGINAS_NO_CONFIGURABLES);
  for (const p of paginas) {
    if (!validas.has(p)) {
      throw new ConvexError(`"${p}" no es una página válida.`);
    }
    if (noConfigurables.has(p)) {
      throw new ConvexError(`"${p}" no es asignable desde aquí — Gestión de Usuarios y Gestión de Roles quedan siempre admin-only, por seguridad.`);
    }
  }
}

// Genera un slug estable a partir del nombre (sin acentos, minúsculas,
// separado por guiones bajos) — es la clave real que queda guardada en
// users.rol, así que nunca cambia una vez creado (renombrar el rol no
// mueve el slug, solo el `nombre` visible).
function slugify(nombre: string): string {
  return nombre
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export const listRoles = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireRole(ctx, token, ['admin']);
    const roles = await ctx.db.query('roles').collect();
    return roles.sort((a, b) => a.orden - b.orden);
  },
});

export const crearRol = mutation({
  args: { nombre: v.string(), paginas: v.array(v.string()), token: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireRole(ctx, args.token, ['admin']);
    const nombre = args.nombre.trim();
    if (!nombre) throw new ConvexError('crearRol: el nombre no puede estar vacío.');
    validarPaginas(args.paginas);

    const slugBase = slugify(nombre);
    if (!slugBase) throw new ConvexError('crearRol: el nombre debe tener al menos una letra o número.');
    // slug único — si colisiona (ej. dos roles que normalizan igual, como
    // "Compras" y "compras "), sufijo numérico incremental. Nunca
    // sobrescribe un rol existente ni falla silenciosamente.
    let slug = slugBase;
    let i = 2;
    while (await ctx.db.query('roles').withIndex('by_slug', (q) => q.eq('slug', slug)).unique()) {
      slug = `${slugBase}_${i++}`;
    }

    const todos = await ctx.db.query('roles').collect();
    const maxOrden = todos.reduce((m, r) => Math.max(m, r.orden), -1);
    const now = Date.now();
    const id = await ctx.db.insert('roles', {
      slug, nombre, paginas: args.paginas, protegido: false, bypassAcceso: false, activo: true,
      orden: maxOrden + 1, updatedAt: now, updatedBy: admin._id,
    });
    return { ok: true, id, slug };
  },
});

// Cuerpo compartido de "editar un rol" — usado tanto por `actualizarRol`
// (uno solo) como por `guardarRolesCompleto` (varios a la vez, para cuando
// Gestión de Roles guarda en lote las ediciones de nombre/páginas de la
// tabla). El rol admin ya viene resuelto por el caller — se valida UNA vez
// por llamada a la mutation pública, no una vez por rol del batch.
async function actualizarRolImpl(
  ctx: MutationCtx,
  admin: { _id: Id<'users'> },
  args: { rolId: Id<'roles'>; nombre?: string; paginas?: string[] }
): Promise<void> {
  const existente = await ctx.db.get(args.rolId);
  if (!existente) throw new ConvexError('actualizarRol: el rol no existe.');
  if (existente.protegido) {
    throw new ConvexError(`actualizarRol: "${existente.nombre}" es un rol protegido, no se puede editar.`);
  }
  const patch: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: admin._id };
  if (args.nombre !== undefined) {
    const nombre = args.nombre.trim();
    if (!nombre) throw new ConvexError('actualizarRol: el nombre no puede estar vacío.');
    patch.nombre = nombre;
  }
  if (args.paginas !== undefined) {
    validarPaginas(args.paginas);
    patch.paginas = args.paginas;
  }
  await ctx.db.patch(args.rolId, patch);
}

export const actualizarRol = mutation({
  args: {
    rolId: v.id('roles'), nombre: v.optional(v.string()), paginas: v.optional(v.array(v.string())),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const admin = await requireRole(ctx, args.token, ['admin']);
    await actualizarRolImpl(ctx, admin, args);
    return { ok: true };
  },
});

// EDS-107 (Fase 4) — batch atómico para "Guardar cambios" de
// gestion-roles.html, mismo patrón ya establecido en
// usuarios.ts::guardarUsuariosCompleto / materiales.ts::guardarCatalogoCompleto:
// una sola mutation transaccional para todas las filas editadas, en vez de
// un loop de mutations independientes desde el cliente (ese patrón viejo
// dejaba guardados parciales reales si una fila a mitad del lote fallaba
// su validación — ya encontrado y corregido varias veces en este proyecto).
export const guardarRolesCompleto = mutation({
  args: {
    roles: v.array(v.object({
      rolId: v.id('roles'), nombre: v.optional(v.string()), paginas: v.optional(v.array(v.string())),
    })),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const admin = await requireRole(ctx, args.token, ['admin']);
    if (args.roles.length === 0) {
      throw new ConvexError('guardarRolesCompleto: no hay cambios que guardar.');
    }
    for (const r of args.roles) {
      await actualizarRolImpl(ctx, admin, r);
    }
    return { ok: true };
  },
});

// Soft-delete (activo:false) — mismo criterio que eliminarUsuario: nada se
// borra de verdad (auditoría). Bloqueada si el rol es protegido, o si
// algún usuario ACTIVO todavía lo tiene asignado (evita dejar usuarios
// reales con un rol fantasma que requireAcceso rechazaría de golpe).
export const eliminarRol = mutation({
  args: { rolId: v.id('roles'), token: v.string() },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.token, ['admin']);
    const existente = await ctx.db.get(args.rolId);
    if (!existente) throw new ConvexError('eliminarRol: el rol no existe.');
    if (existente.protegido) {
      throw new ConvexError(`eliminarRol: "${existente.nombre}" es un rol protegido, no se puede eliminar.`);
    }
    const usuarios = await ctx.db.query('users').collect();
    const enUso = usuarios.some((u) => u.activo && u.rol === existente.slug);
    if (enUso) {
      throw new ConvexError(`eliminarRol: no se puede eliminar "${existente.nombre}" — hay usuarios activos con ese rol. Reasígnalos desde Gestión de Usuarios primero.`);
    }
    await ctx.db.patch(args.rolId, { activo: false, updatedAt: Date.now() });
    return { ok: true };
  },
});

// Simétrico a eliminarRol — un rol desactivado por error puede reactivarse
// sin perder su historial (paginas, orden, etc. quedan intactos).
export const reactivarRol = mutation({
  args: { rolId: v.id('roles'), token: v.string() },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.token, ['admin']);
    const existente = await ctx.db.get(args.rolId);
    if (!existente) throw new ConvexError('reactivarRol: el rol no existe.');
    await ctx.db.patch(args.rolId, { activo: true, updatedAt: Date.now() });
    return { ok: true };
  },
});

// Mapeo de los 5 roles base a exactamente los guards de HOY (ver catálogo
// completo levantado antes de diseñar esta fase) — Fase 2 migra esos
// guards de requireRole a requireAcceso usando este mismo mapeo, así que
// debe quedar sincronizado con el que de verdad se usa en Fase 2.
// Exportado (no solo local): seedData.ts::insertSeedData lo reutiliza para
// sembrar los mismos 5 roles como parte del seed inicial de un deployment
// NUEVO desde cero (hallazgo de CodeRabbit: sin esto, un deployment recién
// sembrado quedaba con el usuario admin insertado pero sin ninguna fila en
// `roles` correspondiente, hasta correr seedRolesBase aparte a mano).
export const ROLES_BASE: Array<{ slug: string; nombre: string; paginas: string[]; protegido: boolean; bypassAcceso: boolean }> = [
  { slug: 'admin', nombre: 'Admin', paginas: [...PAGINAS], protegido: true, bypassAcceso: true },
  { slug: 'gerencia', nombre: 'Gerencia y Comercial', paginas: ['panel-control'], protegido: false, bypassAcceso: false },
  { slug: 'compras', nombre: 'Compras', paginas: ['panel-control', 'entradas-costeo'], protegido: false, bypassAcceso: false },
  { slug: 'calidad', nombre: 'Calidad y Producción', paginas: ['panel-control'], protegido: false, bypassAcceso: false },
  { slug: 'operador', nombre: 'Operador de piso', paginas: ['cierre-turno'], protegido: false, bypassAcceso: false },
];

// EDS-104 — migración idempotente (2ª ronda de revisión: idempotente POR
// ROL, no "la tabla ya tiene algo → no toco nada" — así una corrida
// parcial anterior, o un rol borrado a mano, se completa sola en la
// siguiente corrida sin duplicar ni pisar lo que ya existe). Se corre a
// mano (`npx convex run roles:seedRolesBase`) en cada deployment — dev y
// producción por separado, mismo patrón manual que seedInicial (seed.ts),
// pero sin SEED_SECRET: no crea credenciales ni datos sensibles, solo
// filas de catálogo.
//
// Además valida integridad: reporta (no falla) qué usuarios ACTIVOS
// tienen un `rol` que no corresponde a ningún slug de `roles` — esto
// detectaría, por ejemplo, un typo histórico en users.rol que el union
// fijo de Convex ya no puede atrapar ahora que es v.string(). Correrlo de
// nuevo después de arreglar cualquier usuario huérfano vuelve a dar
// `usuariosHuerfanos: []`.
export const seedRolesBase = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let insertados = 0;
    let yaExistian = 0;
    let reactivados = 0;
    for (const r of ROLES_BASE) {
      const existente = await ctx.db.query('roles').withIndex('by_slug', (q) => q.eq('slug', r.slug)).unique();
      if (existente) {
        yaExistian++;
        // EDS-109: seedRolesBase también sirve como reparación segura. Un
        // rol base que quedó inactivo (borrado a mano, o eventualmente
        // desde Gestión de Roles) dejaba a TODOS sus usuarios sin acceso
        // de forma permanente — volver a correr este seed no lo arreglaba,
        // porque el slug ya existía y se omitía sin más. Reactivar aquí
        // SOLO toca `activo` — nunca `nombre`/`paginas`/`orden`, que
        // pudieron haberse editado a mano desde que se sembró la primera
        // vez; el propósito es restaurar disponibilidad mínima, no
        // revertir personalizaciones administrativas.
        if (!existente.activo) {
          await ctx.db.patch(existente._id, { activo: true, updatedAt: now, updatedBy: null });
          reactivados++;
        }
        continue;
      }
      const maxOrden = (await ctx.db.query('roles').collect()).reduce((m, x) => Math.max(m, x.orden), -1);
      await ctx.db.insert('roles', { ...r, activo: true, orden: maxOrden + 1, updatedAt: now, updatedBy: null });
      insertados++;
    }

    const rolesVigentes = new Set((await ctx.db.query('roles').collect()).map((r) => r.slug));
    const usuarios = await ctx.db.query('users').collect();
    const usuariosHuerfanos = usuarios
      .filter((u) => u.activo && !rolesVigentes.has(u.rol))
      .map((u) => ({ usuario: u.usuario, rol: u.rol }));

    return { ok: true, insertados, yaExistian, reactivados, usuariosHuerfanos };
  },
});
