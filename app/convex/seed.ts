'use node';

// Punto de entrada del seed inicial — correr UNA VEZ desde el dashboard de
// Convex (Functions → seed:seedInicial → Run). Es una action (no mutation)
// porque hashear el password del admin con bcryptjs necesita el runtime de
// Node; el trabajo de insertar filas vive en seedData.ts (mutation normal
// con acceso a ctx.db), que esta action invoca vía ctx.runMutation.
//
// Idempotente: isSeeded (seedData.ts) revisa si `materiales` ya tiene datos
// antes de insertar nada.
import { action } from './_generated/server';
import { internal } from './_generated/api';
import bcrypt from 'bcryptjs';

const ADMIN_USUARIO = 'edson';
const ADMIN_NOMBRE = 'Edson Aguirre';
const ADMIN_PASSWORD_TEMPORAL = 'Tejaflex2026!';

export const seedInicial = action({
  args: {},
  handler: async (ctx) => {
    const yaSembrado = await ctx.runQuery(internal.seedData.isSeeded, {});
    if (yaSembrado) {
      return {
        ok: false,
        mensaje: 'Ya existen materiales en la base — el seed no se vuelve a correr (idempotente).',
      };
    }

    const adminPasswordHash = await bcrypt.hash(ADMIN_PASSWORD_TEMPORAL, 10);

    const resultado = await ctx.runMutation(internal.seedData.insertSeedData, {
      adminPasswordHash,
    });

    return {
      ok: true,
      ...resultado,
      adminUsuario: ADMIN_USUARIO,
      adminNombre: ADMIN_NOMBRE,
      adminPasswordTemporal: ADMIN_PASSWORD_TEMPORAL,
      nota: 'Copia esta contraseña ahora — no se vuelve a mostrar. Cámbiala desde Gestión de Usuarios en cuanto esa pantalla esté conectada (Épica 9).',
    };
  },
});
