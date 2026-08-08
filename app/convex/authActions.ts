'use node';

// Action de login — separada de auth.ts porque bcryptjs.compare corre en
// runtime Node ("use node" aplica a TODO el archivo, y Convex no permite
// definir mutations/queries normales en un archivo con esa directiva). Esta
// action no toca ctx.db directamente: delega en las internal functions de
// auth.ts vía ctx.runQuery/ctx.runMutation.
import { v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import bcrypt from 'bcryptjs';

export const login = action({
  args: {
    usuario: v.string(),
    password: v.string(),
    remember: v.boolean(),
  },
  handler: async (ctx, { usuario, password, remember }) => {
    const user = await ctx.runQuery(internal.auth.getUserByUsuario, { usuario });

    // Mismo mensaje genérico si el usuario no existe, está inactivo, o la
    // contraseña no coincide — no revelar cuál de las tres cosas falló.
    if (!user || !user.activo) {
      throw new Error('Usuario o contraseña incorrectos.');
    }
    const valido = await bcrypt.compare(password, user.passwordHash);
    if (!valido) {
      throw new Error('Usuario o contraseña incorrectos.');
    }

    const { token, expiresAt } = await ctx.runMutation(internal.auth.createSession, {
      userId: user._id,
      remember,
    });

    return {
      token,
      expiresAt,
      nombre: user.nombre,
      usuario: user.usuario,
      rol: user.rol,
    };
  },
});
