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
import { v } from 'convex/values';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const ADMIN_USUARIO = 'edson';
const ADMIN_NOMBRE = 'Edson Aguirre';

// Password aleatoria por corrida — nunca queda una credencial fija en el
// repo. Legible pero con suficiente entropía (~96 bits en base64url).
function generarPasswordTemporal() {
  return crypto.randomBytes(12).toString('base64url');
}

// Comparación resistente a timing attacks (crypto.timingSafeEqual exige
// buffers del mismo largo, así que primero se descarta por longitud).
function secretosCoinciden(recibido, esperado) {
  const bufRecibido = Buffer.from(recibido);
  const bufEsperado = Buffer.from(esperado);
  if (bufRecibido.length !== bufEsperado.length) return false;
  return crypto.timingSafeEqual(bufRecibido, bufEsperado);
}

export const seedInicial = action({
  // seedSecret evita que cualquiera con acceso al dashboard/API pública de
  // Convex pueda sembrar la base y quedarse con la contraseña del admin
  // recién creado — se compara contra la variable de entorno SEED_SECRET
  // del deployment (`npx convex env set SEED_SECRET <valor-largo>`).
  args: { seedSecret: v.string() },
  handler: async (ctx, { seedSecret }) => {
    const esperado = process.env.SEED_SECRET;
    if (!esperado) {
      throw new Error(
        'SEED_SECRET no está configurado en este deployment — no se puede correr el seed sin él. Configúralo con `npx convex env set SEED_SECRET <valor-largo-y-aleatorio>`.'
      );
    }
    if (!secretosCoinciden(seedSecret, esperado)) {
      throw new Error('seedSecret incorrecto.');
    }

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
