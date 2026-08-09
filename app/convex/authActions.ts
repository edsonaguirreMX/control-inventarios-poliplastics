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
    // Rate limit ANTES de tocar la base de usuarios o bcrypt — una cuenta
    // bloqueada no debe gastar ni una consulta ni un hash de más (EDS-70).
    const { bloqueado } = await ctx.runQuery(internal.auth.verificarRateLimitLogin, { usuario });
    if (bloqueado) {
      throw new Error('Demasiados intentos fallidos. Espera unos minutos antes de volver a intentar.');
    }

    const user = await ctx.runQuery(internal.auth.getUserByUsuario, { usuario });

    // Mismo mensaje genérico si el usuario no existe, está inactivo, o la
    // contraseña no coincide — no revelar cuál de las tres cosas falló.
    if (!user || !user.activo) {
      await ctx.runMutation(internal.auth.registrarIntentoFallidoLogin, { usuario });
      throw new Error('Usuario o contraseña incorrectos.');
    }
    const valido = await bcrypt.compare(password, user.passwordHash);
    if (!valido) {
      await ctx.runMutation(internal.auth.registrarIntentoFallidoLogin, { usuario });
      throw new Error('Usuario o contraseña incorrectos.');
    }
    await ctx.runMutation(internal.auth.limpiarIntentosLogin, { usuario });

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
