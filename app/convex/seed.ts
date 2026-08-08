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
import crypto from 'node:crypto';

const ADMIN_USUARIO = 'edson';
const ADMIN_NOMBRE = 'Edson Aguirre';

// Password aleatoria por corrida — nunca queda una credencial fija en el
// repo. Legible pero con suficiente entropía (~96 bits en base64url).
function generarPasswordTemporal() {
  return crypto.randomBytes(12).toString('base64url');
}

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

    const adminPasswordTemporal = generarPasswordTemporal();
    const adminPasswordHash = await bcrypt.hash(adminPasswordTemporal, 10);

    const resultado = await ctx.runMutation(internal.seedData.insertSeedData, {
      adminPasswordHash,
    });

    return {
      ok: true,
      ...resultado,
      adminUsuario: ADMIN_USUARIO,
      adminNombre: ADMIN_NOMBRE,
      adminPasswordTemporal,
      nota: 'Copia esta contraseña ahora — no se vuelve a mostrar ni queda guardada en ningún lado en texto plano. Cámbiala desde Gestión de Usuarios en cuanto esa pantalla esté conectada (Épica 9).',
    };
  },
});
