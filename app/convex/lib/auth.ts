import { ConvexError } from 'convex/values';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

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
