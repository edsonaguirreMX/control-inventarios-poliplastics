import { v, ConvexError } from 'convex/values';
import { mutation } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { crearCapaImpl } from './peps';
import { requireRole } from './lib/auth';
import { horaLocalAInstante } from './lib/fechaOperativa';

// EDS-41 / tarea 3.5 — Importación de inventario inicial: reemplaza el
// control en Excel con el que operaba la planta antes de este sistema.
// Carga las capas PEPS de arranque a partir del conteo físico real
// (kg y costo actual de cada material), para que el sistema empiece con
// inventario real en vez de en cero.
//
// Todo el corte comparte el MISMO instante real (fecha + hora locales de
// cuándo se hizo el conteo físico) — un solo `fechaISO`/`horaCorte` para
// todo el lote, no un campo por fila: físicamente es un solo conteo de
// planta, no N conteos independientes por material. Ese instante se
// vuelve la `fechaEntrada` de cada capa nueva — al ser la más antigua de
// todo el ledger, PEPS la consume primero (correcto: es el inventario más
// viejo que hay en existencia al arrancar).
//
// Ejecutable UNA SOLA VEZ por material: si ya existe una capa de ese
// material con origen:"inventarioInicial", la importación ya corrió para
// él y la mutation rechaza explícitamente (evita duplicar el arranque por
// error, p. ej. reenviar el mismo archivo dos veces).
//
// Admin-only — igual que Catálogo/Parámetros, es una operación que toca
// costeo real de toda la planta.

async function validarFilaImportacion(
  ctx: MutationCtx,
  fila: { materialId: Id<'materiales'>; kgOriginal: number; costoUnitario: number }
) {
  const material = await ctx.db.get(fila.materialId);
  if (!material) {
    throw new ConvexError('importarInventarioInicial: uno de los materiales seleccionados no existe.');
  }
  if (fila.kgOriginal < 0) {
    throw new ConvexError(`importarInventarioInicial: los kg de ${material.nombre} no pueden ser negativos.`);
  }
  if (fila.costoUnitario < 0) {
    throw new ConvexError(`importarInventarioInicial: el costo de ${material.nombre} no puede ser negativo.`);
  }
  // Misma regla dura que Catálogo (materiales.ts actualizarMaterialImpl):
  // Triturado (material interno) siempre se valúa en $0, sin excepción —
  // ni siquiera al cargar el inventario de arranque.
  if (material.esInterno && fila.costoUnitario !== 0) {
    throw new ConvexError(
      `El costo de ${material.nombre} (material interno) siempre es $0 — no se puede importar con otro costo.`
    );
  }

  const capasPrevias = await ctx.db
    .query('capasCosto')
    .withIndex('by_material_fecha', (q) => q.eq('materialId', fila.materialId))
    .collect();
  if (capasPrevias.some((c) => c.origen === 'inventarioInicial')) {
    throw new ConvexError(
      `${material.nombre} ya tiene un inventario inicial importado — esta operación solo puede correr una vez por material.`
    );
  }

  return material;
}

export const importarInventarioInicial = mutation({
  args: {
    fechaISO: v.string(), // "YYYY-MM-DD" — fecha real del corte físico
    horaCorte: v.string(), // "HH:MM" — hora real del corte físico, en zonaHoraria de parametrosProduccion
    materiales: v.array(
      v.object({
        materialId: v.id('materiales'),
        kgOriginal: v.number(),
        costoUnitario: v.number(),
      })
    ),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['admin']);

    if (args.materiales.length === 0) {
      throw new ConvexError('importarInventarioInicial: se necesita al menos un material.');
    }
    const idsUnicos = new Set(args.materiales.map((m) => m.materialId));
    if (idsUnicos.size !== args.materiales.length) {
      throw new ConvexError('importarInventarioInicial: hay un material repetido en la misma importación.');
    }

    const params = await ctx.db.query('parametrosProduccion').first();
    if (!params) {
      throw new Error('importarInventarioInicial: no hay parámetros de producción configurados (falta zonaHoraria).');
    }
    const fechaEntrada = horaLocalAInstante(args.fechaISO, args.horaCorte, params.zonaHoraria);

    // Primera pasada: valida TODO antes de escribir nada. Convex ya hace
    // atómica la mutation completa (si algo lanza, se descarta toda la
    // transacción), pero validar primero deja el error más claro — nunca
    // "el material 3 de 8 falló" después de haber insertado ya las
    // primeras 2 capas (que de todas formas se revertirían solas).
    for (const fila of args.materiales) {
      await validarFilaImportacion(ctx, fila);
    }

    const capaIds: Id<'capasCosto'>[] = [];
    for (const fila of args.materiales) {
      const capaId = await crearCapaImpl(ctx, {
        materialId: fila.materialId,
        kgOriginal: fila.kgOriginal,
        costoUnitario: fila.costoUnitario,
        fechaEntrada,
        origen: 'inventarioInicial',
        entradaId: null,
        cierreTurnoId: null,
        origenTipo: 'inventarioInicial',
        origenId: args.fechaISO,
        createdBy: user._id,
      });
      capaIds.push(capaId);
    }

    return { ok: true, capaIds };
  },
});
