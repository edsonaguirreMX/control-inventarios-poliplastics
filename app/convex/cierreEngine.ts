import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { crearCapaImpl, consumirFIFOImpl, revertirConsumoImpl } from './peps';

// Motor compartido de aplicar/revertir el efecto de un cierre de turno sobre
// el inventario. Es la ÚNICA forma de crear o modificar ese efecto — 4.2
// (crearCierreTurno) y 5.2 (actualizarCierreTurno) son wrappers delgados
// sobre aplicarCierreImpl/revertirCierreImpl.
//
// Patrón de uso (idéntico para cierre nuevo, recierre, o corrección):
//   cierreTurnoId = insert cierresTurno (valores capturados, totales en 0)
//   → aplicarCierreImpl({cierreTurnoId, ...}) → patch(cierreTurnoId, totales)
// Para un recierre/corrección sobre un cierreTurnoId que ya existe:
//   revertirCierreImpl({cierreTurnoId}) → aplicarCierreImpl({cierreTurnoId, valoresNuevos})
//   → patch(cierreTurnoId, totalesNuevos + editado/vecesRecapturado)
//
// aplicarCierreImpl/revertirCierreImpl NUNCA escriben el doc `cierresTurno`
// directamente — eso es responsabilidad del caller (4.2/5.2), que es quien
// sabe qué otros campos (editado, vecesRecapturado, etc.) hay que actualizar
// junto con los totales.

const CAB_105_KG = 1.25;
const CAB_106_KG = 1.9;

export async function aplicarCierreImpl(
  ctx: MutationCtx,
  args: {
    cierreTurnoId: Id<'cierresTurno'>;
    metrosBuenos: number;
    caballetes105Pzas: number;
    caballetes106Pzas: number;
    consumoPorMaterial: { materialId: Id<'materiales'>; kgConsumido: number }[];
    createdBy: Id<'users'>;
  }
): Promise<{
  kgBuenos: number;
  mermaTotalKg: number;
  caballetesKg: number;
  trituradoKg: number;
  costoTotalConsumido: number;
  costoRealPorKg: number;
  costoRealPorMetro: number;
}> {
  const parametros = await ctx.db.query('parametrosProduccion').first();
  if (!parametros) {
    throw new Error('aplicarCierre: no hay parametrosProduccion configurados — corre el seed primero.');
  }

  const kgBuenos = args.metrosBuenos * parametros.kgPorMetro;
  const totalConsumo = args.consumoPorMaterial.reduce((s, c) => s + c.kgConsumido, 0);
  const mermaTotalKg = Math.max(0, totalConsumo - kgBuenos);
  const caballetesKg = Math.min(
    mermaTotalKg,
    args.caballetes105Pzas * CAB_105_KG + args.caballetes106Pzas * CAB_106_KG
  );
  const trituradoKg = Math.max(0, mermaTotalKg - caballetesKg);

  let costoTotalConsumido = 0;
  for (const c of args.consumoPorMaterial) {
    if (c.kgConsumido <= 0) continue;
    const resultado = await consumirFIFOImpl(ctx, {
      materialId: c.materialId,
      kgAConsumir: c.kgConsumido,
      origenTipo: 'cierreTurno',
      origenId: String(args.cierreTurnoId),
      createdBy: args.createdBy,
    });
    costoTotalConsumido += resultado.costoTotal;
    await ctx.db.insert('cierreConsumos', {
      cierreTurnoId: args.cierreTurnoId,
      materialId: c.materialId,
      kgConsumido: c.kgConsumido,
      costoTotal: resultado.costoTotal,
      faltanteKg: resultado.faltanteKg,
      vigente: true,
      capasDetalle: resultado.capasDetalle,
    });
  }

  if (trituradoKg > 0) {
    const triturado = await ctx.db
      .query('materiales')
      .withIndex('by_slug', (q) => q.eq('slug', 'triturado'))
      .unique();
    if (!triturado) {
      throw new Error('aplicarCierre: no existe el material Triturado (slug "triturado") en el catálogo.');
    }
    await crearCapaImpl(ctx, {
      materialId: triturado._id,
      kgOriginal: trituradoKg,
      costoUnitario: 0,
      origen: 'triturado',
      entradaId: null,
      cierreTurnoId: args.cierreTurnoId,
      origenTipo: 'cierreTurno',
      origenId: String(args.cierreTurnoId),
      createdBy: args.createdBy,
    });
  }

  const costoRealPorKg = kgBuenos > 0 ? costoTotalConsumido / kgBuenos : 0;
  const costoRealPorMetro = costoRealPorKg * parametros.kgPorMetro;

  return { kgBuenos, mermaTotalKg, caballetesKg, trituradoKg, costoTotalConsumido, costoRealPorKg, costoRealPorMetro };
}

export async function revertirCierreImpl(
  ctx: MutationCtx,
  args: { cierreTurnoId: Id<'cierresTurno'>; createdBy: Id<'users'> }
): Promise<{ ok: true }> {
  const consumosVigentes = await ctx.db
    .query('cierreConsumos')
    .withIndex('by_cierreTurnoId_vigente', (q) => q.eq('cierreTurnoId', args.cierreTurnoId).eq('vigente', true))
    .collect();

  for (const consumo of consumosVigentes) {
    await revertirConsumoImpl(ctx, { cierreConsumoId: consumo._id, createdBy: args.createdBy });
    await ctx.db.patch(consumo._id, { vigente: false });
  }

  // Capa de Triturado que este cierre generó (a lo sumo una activa — un
  // recierre previo pudo haber dejado capas ya agotadas/voided de rondas
  // anteriores, por eso se filtra por agotada:false en vez de usar .unique()
  // directo sobre el índice).
  const capasTriturado = await ctx.db
    .query('capasCosto')
    .withIndex('by_cierreTurnoId_origen', (q) => q.eq('cierreTurnoId', args.cierreTurnoId).eq('origen', 'triturado'))
    .collect();
  const capaTriturado = capasTriturado.find((c) => !c.agotada) ?? null;

  if (capaTriturado) {
    // Consumo NETO, no solo "¿existe algún movimiento tipo consumo?" — nada
    // se borra en este sistema, así que un consumo que ya fue revertido
    // (reversa_consumo) sigue viéndose en el historial para siempre. Si no
    // se descuenta, un cierre posterior que consumió y luego revirtió esta
    // capa dejaría bloqueada la reversión de ESTE cierre para siempre.
    const movimientos = await ctx.db
      .query('capaMovimientos')
      .withIndex('by_capaId', (q) => q.eq('capaId', capaTriturado._id))
      .collect();
    const consumoNeto = movimientos.reduce((neto, m) => {
      if (m.tipo === 'consumo') return neto + m.kg;
      if (m.tipo === 'reversa_consumo') return neto - m.kg;
      return neto;
    }, 0);

    if (consumoNeto > 0) {
      throw new Error(
        `Este cierre no se puede revertir: el Triturado que generó tiene ${consumoNeto}kg consumidos (netos) por un cierre posterior — revierte ese cierre primero.`
      );
    }

    await ctx.db.patch(capaTriturado._id, { kgRestante: 0, agotada: true });
    await ctx.db.insert('capaMovimientos', {
      capaId: capaTriturado._id,
      materialId: capaTriturado.materialId,
      tipo: 'reversa_generacion',
      kg: capaTriturado.kgOriginal,
      costoUnitario: capaTriturado.costoUnitario,
      origenTipo: 'correccion',
      origenId: String(args.cierreTurnoId),
      createdAt: Date.now(),
      createdBy: args.createdBy,
    });
  }

  return { ok: true };
}

// --- Wrappers registrados (invocación aislada: pruebas o desde una action).
// A propósito internalMutation — 4.2/5.2 importan y llaman los *Impl
// directamente dentro de su propia transacción, no estos wrappers. ---

export const aplicarCierre = internalMutation({
  args: {
    cierreTurnoId: v.id('cierresTurno'),
    metrosBuenos: v.number(),
    caballetes105Pzas: v.number(),
    caballetes106Pzas: v.number(),
    consumoPorMaterial: v.array(v.object({ materialId: v.id('materiales'), kgConsumido: v.number() })),
    createdBy: v.id('users'),
  },
  handler: async (ctx, args) => aplicarCierreImpl(ctx, args),
});

export const revertirCierre = internalMutation({
  args: { cierreTurnoId: v.id('cierresTurno'), createdBy: v.id('users') },
  handler: async (ctx, args) => revertirCierreImpl(ctx, args),
});
