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

export async function requireUser(
  ctx: QueryCtx | MutationCtx,
  token: string | null | undefined
): Promise<Doc<'users'>> {
  if (!token) {
    throw new Error('No autenticado: falta el token de sesión.');
  }
  const session = await ctx.db
    .query('sessions')
    .withIndex('by_token', (q) => q.eq('token', token))
    .unique();
  if (!session) {
    throw new Error('No autenticado: sesión inválida.');
  }
  if (session.expiresAt < Date.now()) {
    throw new Error('No autenticado: sesión expirada, vuelve a iniciar sesión.');
  }
  const user = await ctx.db.get(session.userId);
  if (!user || !user.activo) {
    throw new Error('No autenticado: usuario inválido o inactivo.');
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
    throw new Error(
      `No autorizado: se requiere rol ${roles.join(' o ')} (rol actual: ${user.rol}).`
    );
  }
  return user;
}
