'use node';

// Actions de Gestión de Usuarios — separadas de usuarios.ts porque
// bcryptjs.hash corre en runtime Node ("use node" aplica a TODO el
// archivo, y Convex no permite mutations/queries normales en un archivo
// con esa directiva). Mismo patrón que auth.ts/authActions.ts. Ninguna
// toca ctx.db directo: delegan en las internal functions de usuarios.ts
// vía ctx.runQuery/ctx.runMutation.
import { v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';

// EDS-104: ver mismo comentario en usuarios.ts — antes union fijo de 5
// literales, ahora string libre validado (existe + activo en `roles`)
// dentro de crearUsuarioImpl, a donde esta action delega.
const ROL_VALUE = v.string();

// Mismo alfabeto sin caracteres ambiguos (0/O, 1/l/I) que usa seed.ts para
// el password temporal del admin inicial — para que un humano pueda
// copiarlo/leerlo en voz alta sin confusiones. randomInt (node:crypto,
// CSPRNG) en vez de Math.random() (hallazgo de CodeRabbit en PR7: un
// password de un solo uso generado con un PRNG no criptográfico es
// teóricamente predecible) — este archivo ya corre en runtime Node
// ('use node' arriba), así que node:crypto está disponible sin dependencia
// nueva.
function generarPasswordTemporal(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[randomInt(chars.length)];
  return s + '!';
}

// El password en claro se regresa UNA sola vez en la respuesta — nunca se
// guarda en ningún lado más que el hash. La pantalla lo muestra en un
// modal de confirmación y no lo vuelve a pedir (tarea 9.2).
export const crearUsuario = action({
  args: { nombre: v.string(), usuario: v.string(), rol: ROL_VALUE, token: v.string() },
  handler: async (ctx, args): Promise<{ passwordTemporal: string }> => {
    await ctx.runQuery(internal.usuarios.verificarAdminImpl, { token: args.token });
    const passwordTemporal = generarPasswordTemporal();
    const passwordHash = await bcrypt.hash(passwordTemporal, 10);
    await ctx.runMutation(internal.usuarios.crearUsuarioImpl, {
      nombre: args.nombre, usuario: args.usuario, passwordHash, rol: args.rol,
    });
    return { passwordTemporal };
  },
});

export const regenerarPassword = action({
  args: { userId: v.id('users'), token: v.string() },
  handler: async (ctx, args): Promise<{ passwordTemporal: string }> => {
    await ctx.runQuery(internal.usuarios.verificarAdminImpl, { token: args.token });
    const passwordTemporal = generarPasswordTemporal();
    const passwordHash = await bcrypt.hash(passwordTemporal, 10);
    await ctx.runMutation(internal.usuarios.actualizarPasswordImpl, { userId: args.userId, passwordHash });
    return { passwordTemporal };
  },
});
