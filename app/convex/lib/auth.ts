import { ConvexError } from 'convex/values';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import type { Pagina } from './paginas';

export type Rol = 'operador' | 'admin' | 'gerencia' | 'compras' | 'calidad';

/**
 * Helpers de autorización server-side, reutilizados por CUALQUIER
 * query/mutation sensible del backend desde su propia tarea (no como
 * auditoría al final del proyecto — ver 10.2, que es solo la pasada de
 * confirmación).
 *
 * Reciben el `ctx` de la función que los llama, así que solo se usan dentro
 * de queries/mutations (no de actions directamente — una action que
 * necesite autorizar lo hace vía ctx.runQuery a una función que sí use
 * estos helpers).
 */

// EDS-73: ConvexError, no Error, en las 5 salidas de este archivo — se usan
// desde CADA función protegida del backend, así que cualquier sesión que
// expira o cualquier navegación a una pantalla fuera del rol del usuario
// pasa por aquí. Un Error normal llega al cliente como "Server Error"
// genérico en producción (Convex redacta el mensaje salvo que sea
// ConvexError); con ConvexError el mensaje real ("vuelve a iniciar
// sesión", "no autorizado") llega íntegro.
export async function requireUser(
  ctx: QueryCtx | MutationCtx,
  token: string | null | undefined
): Promise<Doc<'users'>> {
  if (!token) {
    throw new ConvexError('No autenticado: falta el token de sesión.');
  }
  const session = await ctx.db
    .query('sessions')
    .withIndex('by_token', (q) => q.eq('token', token))
    .unique();
  if (!session) {
    throw new ConvexError('No autenticado: sesión inválida.');
  }
  if (session.expiresAt < Date.now()) {
    throw new ConvexError('No autenticado: sesión expirada, vuelve a iniciar sesión.');
  }
  const user = await ctx.db.get(session.userId);
  if (!user || !user.activo) {
    throw new ConvexError('No autenticado: usuario inválido o inactivo.');
  }
  return user;
}

export async function requireRole(
  ctx: QueryCtx | MutationCtx,
  token: string | null | undefined,
  roles: Rol[]
): Promise<Doc<'users'>> {
  const user = await requireUser(ctx, token);
  if (!roles.includes(user.rol as Rol)) {
    throw new ConvexError(
      `No autorizado: se requiere rol ${roles.join(' o ')} (rol actual: ${user.rol}).`
    );
  }
  return user;
}

// EDS-104 — reemplaza gradualmente a requireRole (que se queda vivo, sin
// tocar y SIN eliminarse nunca — decisión de la 2ª ronda de revisión:
// Gestión de Usuarios y Gestión de Roles necesitan una autorización FIJA
// que no dependa del sistema dinámico que ellas mismas administran, así
// que requireRole no es "código viejo a borrar en Fase 5", es el
// mecanismo permanente de esas 2 pantallas) para las funciones que
// existen para servir UNA o VARIAS pantallas concretas. `paginas` es la
// página (o páginas, si la función es compartida por más de una pantalla
// — ej. correcciones.ts::actualizarEntrada, usada desde correccion-
// capturas.html Y entradas-costeo.html) cuyo acceso habilita esta función;
// basta con que el rol tenga acceso a UNA de ellas. Catálogo de páginas
// en ./paginas.ts (fuente única, ver ahí el mapeo slug→archivo real).
export async function requireAcceso(
  ctx: QueryCtx | MutationCtx,
  token: string | null | undefined,
  paginas: Pagina | Pagina[]
): Promise<Doc<'users'>> {
  const user = await requireUser(ctx, token);
  const rol = await ctx.db
    .query('roles')
    .withIndex('by_slug', (q) => q.eq('slug', user.rol))
    .unique();
  if (!rol || !rol.activo) {
    throw new ConvexError(`No autenticado: tu rol ("${user.rol}") ya no existe o está inactivo — contacta a un administrador.`);
  }
  // bypassAcceso (solo "admin" hoy) siempre pasa, sin importar qué traiga
  // `paginas` — distinto de `protegido` (que solo bloquea EDITAR el rol
  // desde Gestión de Roles, ver schema.ts). Mismo espíritu que la vieja
  // garantía "siempre hay un admin activo".
  if (rol.bypassAcceso) return user;
  const requeridas = Array.isArray(paginas) ? paginas : [paginas];
  if (!requeridas.some((p) => rol.paginas.includes(p))) {
    throw new ConvexError(`No autorizado: tu rol no tiene acceso a esta función (requiere: ${requeridas.join(' o ')}).`);
  }
  return user;
}
