import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { requireUser } from './lib/auth';

// Motor de costeo PEPS/FIFO. Reglas de negocio que este archivo existe para
// garantizar (ver plan: ~/.claude/plans/quiero-que-hagas-el-wise-creek.md):
//   1. Las salidas siempre consumen la capa más antigua primero (FIFO real).
//   2. Un material normal NUNCA se consume por encima de su existencia —
//      consumirFIFO bloquea con error en vez de subcostear.
//   3. Triturado (materiales.esInterno) es la ÚNICA excepción: su faltante
//      es fisout normal de la operación y su costo siempre es $0, así que
//      no hay riesgo de subcosteo si se permite.
//   4. Todo movimiento de capa (generación, consumo, reversa) queda en el
//      ledger inmutable `capaMovimientos` — es la fuente de verdad auditable,
//      `capasCosto.kgRestante` es solo un caché derivado reconciliable
//      contra ese ledger.
//
// Cada operación tiene una función plana `xxxImpl(ctx, args)` y un wrapper
// registrado `xxx` (internalMutation) alrededor de ella. Motivo: Convex NO
// permite que una mutation llame a otra mutation registrada vía
// ctx.runMutation (eso solo existe en ActionCtx) — así que cierreEngine.ts,
// entradas.ts, etc. importan y llaman los *Impl directamente dentro de su
// propia transacción, y los wrappers registrados quedan para invocación
// aislada (pruebas, o desde una action). Ninguna de las dos formas se
// expone directo a un rol — siempre las compone algo que ya hizo su propio
// requireRole antes.

type OrigenCapa = 'entrada' | 'triturado' | 'inventarioInicial';
type OrigenTipo = 'entrada' | 'cierreTurno' | 'correccion' | 'inventarioInicial';

export async function crearCapaImpl(
  ctx: MutationCtx,
  args: {
    materialId: Id<'materiales'>;
    kgOriginal: number;
    costoUnitario: number;
    origen: OrigenCapa;
    entradaId: Id<'entradas'> | null;
    cierreTurnoId: Id<'cierresTurno'> | null;
    origenTipo: OrigenTipo;
    origenId: string;
    createdBy: Id<'users'>;
  }
): Promise<Id<'capasCosto'>> {
  if (args.kgOriginal < 0) {
    throw new Error('crearCapa: kgOriginal no puede ser negativo.');
  }
  if (args.costoUnitario < 0) {
    throw new Error('crearCapa: costoUnitario no puede ser negativo.');
  }

  const now = Date.now();
  const capaId = await ctx.db.insert('capasCosto', {
    materialId: args.materialId,
    fechaEntrada: now,
    kgOriginal: args.kgOriginal,
    kgRestante: args.kgOriginal,
    costoUnitario: args.costoUnitario,
    origen: args.origen,
    entradaId: args.entradaId,
    cierreTurnoId: args.cierreTurnoId,
    agotada: args.kgOriginal <= 0,
    createdAt: now,
  });

  await ctx.db.insert('capaMovimientos', {
    capaId,
    materialId: args.materialId,
    tipo: 'generacion',
    kg: args.kgOriginal,
    costoUnitario: args.costoUnitario,
    origenTipo: args.origenTipo,
    origenId: args.origenId,
    createdAt: now,
    createdBy: args.createdBy,
  });

  return capaId;
}

export async function consumirFIFOImpl(
  ctx: MutationCtx,
  args: {
    materialId: Id<'materiales'>;
    kgAConsumir: number;
    origenTipo: OrigenTipo;
    origenId: string;
    createdBy: Id<'users'>;
  }
): Promise<{
  costoTotal: number;
  capasDetalle: { capaId: Id<'capasCosto'>; kgTomado: number; costoUnitario: number }[];
  faltanteKg: number;
}> {
  const { materialId, kgAConsumir, origenTipo, origenId, createdBy } = args;

  if (kgAConsumir < 0) {
    throw new Error('consumirFIFO: kgAConsumir no puede ser negativo.');
  }
  if (kgAConsumir === 0) {
    return { costoTotal: 0, capasDetalle: [], faltanteKg: 0 };
  }

  const material = await ctx.db.get(materialId);
  if (!material) {
    throw new Error(`consumirFIFO: material ${materialId} no existe.`);
  }

  // FIFO real: capas del material, no agotadas, ordenadas por fecha de
  // entrada ascendente (la más antigua primero) — by_material_fecha ya
  // las entrega en ese orden con .order('asc').
  const capas = await ctx.db
    .query('capasCosto')
    .withIndex('by_material_fecha', (q) => q.eq('materialId', materialId))
    .order('asc')
    .filter((q) => q.eq(q.field('agotada'), false))
    .collect();

  const disponible = capas.reduce((sum, c) => sum + c.kgRestante, 0);

  // Bloquea por faltante — nunca subcostea — salvo Triturado, cuyo
  // faltante es una realidad física de la operación (se generó menos
  // merma reciclable de la esperada) y cuyo costo siempre es $0.
  if (disponible < kgAConsumir && !material.esInterno) {
    throw new Error(
      `Inventario insuficiente de ${material.nombre} (${material.variante}): disponible ${disponible}kg, requerido ${kgAConsumir}kg — registra una entrada antes de cerrar el turno.`
    );
  }

  let restante = kgAConsumir;
  let costoTotal = 0;
  const capasDetalle: { capaId: Id<'capasCosto'>; kgTomado: number; costoUnitario: number }[] = [];
  const now = Date.now();

  for (const capa of capas) {
    if (restante <= 0) break;
    const kgTomado = Math.min(capa.kgRestante, restante);
    if (kgTomado <= 0) continue;

    costoTotal += kgTomado * capa.costoUnitario;
    capasDetalle.push({ capaId: capa._id, kgTomado, costoUnitario: capa.costoUnitario });

    const nuevoRestante = capa.kgRestante - kgTomado;
    await ctx.db.patch(capa._id, { kgRestante: nuevoRestante, agotada: nuevoRestante <= 0 });
    await ctx.db.insert('capaMovimientos', {
      capaId: capa._id,
      materialId,
      tipo: 'consumo',
      kg: kgTomado,
      costoUnitario: capa.costoUnitario,
      origenTipo,
      origenId,
      createdAt: now,
      createdBy,
    });

    restante -= kgTomado;
  }

  // Si llegamos aquí con restante > 0, solo puede ser Triturado (los
  // materiales normales ya lanzaron error arriba antes de tocar nada).
  return { costoTotal, capasDetalle, faltanteKg: restante };
}

export async function revertirConsumoImpl(
  ctx: MutationCtx,
  args: { cierreConsumoId: Id<'cierreConsumos'>; createdBy: Id<'users'> }
): Promise<{ ok: true }> {
  const { cierreConsumoId, createdBy } = args;
  const consumo = await ctx.db.get(cierreConsumoId);
  if (!consumo) {
    throw new Error(`revertirConsumo: cierreConsumos ${cierreConsumoId} no existe.`);
  }

  const now = Date.now();
  for (const detalle of consumo.capasDetalle) {
    const capa = await ctx.db.get(detalle.capaId);
    if (!capa) {
      // No debería pasar (nada se borra en este sistema), pero no tumbar
      // la reversa completa por una capa individual faltante.
      continue;
    }
    const nuevoRestante = capa.kgRestante + detalle.kgTomado;
    await ctx.db.patch(detalle.capaId, { kgRestante: nuevoRestante, agotada: false });
    await ctx.db.insert('capaMovimientos', {
      capaId: detalle.capaId,
      materialId: capa.materialId,
      tipo: 'reversa_consumo',
      kg: detalle.kgTomado,
      costoUnitario: detalle.costoUnitario,
      origenTipo: 'correccion',
      origenId: String(cierreConsumoId),
      createdAt: now,
      createdBy,
    });
  }

  return { ok: true };
}

// --- Wrappers registrados (invocación aislada: pruebas o desde una action).
// A propósito internalMutation — nunca expuestos directo a un rol. ---

export const crearCapa = internalMutation({
  args: {
    materialId: v.id('materiales'),
    kgOriginal: v.number(),
    costoUnitario: v.number(),
    origen: v.union(v.literal('entrada'), v.literal('triturado'), v.literal('inventarioInicial')),
    entradaId: v.union(v.id('entradas'), v.null()),
    cierreTurnoId: v.union(v.id('cierresTurno'), v.null()),
    origenTipo: v.union(v.literal('entrada'), v.literal('cierreTurno'), v.literal('correccion'), v.literal('inventarioInicial')),
    origenId: v.string(),
    createdBy: v.id('users'),
  },
  handler: async (ctx, args) => crearCapaImpl(ctx, args),
});

export const consumirFIFO = internalMutation({
  args: {
    materialId: v.id('materiales'),
    kgAConsumir: v.number(),
    origenTipo: v.union(v.literal('entrada'), v.literal('cierreTurno'), v.literal('correccion'), v.literal('inventarioInicial')),
    origenId: v.string(),
    createdBy: v.id('users'),
  },
  handler: async (ctx, args) => consumirFIFOImpl(ctx, args),
});

export const revertirConsumo = internalMutation({
  args: {
    cierreConsumoId: v.id('cierreConsumos'),
    createdBy: v.id('users'),
  },
  handler: async (ctx, args) => revertirConsumoImpl(ctx, args),
});

// --- Lectura pública (requiere sesión válida, cualquier rol — la
// restricción de rol específica vive en la pantalla que consuma esto) ---

export const existenciaMaterial = query({
  args: { materialId: v.id('materiales'), token: v.string() },
  handler: async (ctx, { materialId, token }) => {
    await requireUser(ctx, token);
    const capas = await ctx.db
      .query('capasCosto')
      .withIndex('by_material_agotada', (q) => q.eq('materialId', materialId).eq('agotada', false))
      .collect();
    return capas.reduce((sum, c) => sum + c.kgRestante, 0);
  },
});

export const valorInventarioMaterial = query({
  args: { materialId: v.id('materiales'), token: v.string() },
  handler: async (ctx, { materialId, token }) => {
    await requireUser(ctx, token);
    const capas = await ctx.db
      .query('capasCosto')
      .withIndex('by_material_agotada', (q) => q.eq('materialId', materialId).eq('agotada', false))
      .collect();
    return capas.reduce((sum, c) => sum + c.kgRestante * c.costoUnitario, 0);
  },
});
