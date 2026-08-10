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
  // Ningún dato capturado puede ser negativo — un cierre con metros o
  // consumo negativo alteraría merma/costo real sin que nada lo detecte.
  if (args.metrosBuenos < 0) {
    throw new Error('aplicarCierre: metrosBuenos no puede ser negativo.');
  }
  if (args.caballetes105Pzas < 0) {
    throw new Error('aplicarCierre: caballetes105Pzas no puede ser negativo.');
  }
  if (args.caballetes106Pzas < 0) {
    throw new Error('aplicarCierre: caballetes106Pzas no puede ser negativo.');
  }
  for (const c of args.consumoPorMaterial) {
    if (c.kgConsumido < 0) {
      throw new Error(`aplicarCierre: kgConsumido no puede ser negativo (material ${c.materialId}).`);
    }
  }

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
      // El Triturado entra al inventario exactamente en el momento del
      // cierre que lo generó — "ahora" SÍ es su fecha real de recepción,
      // a diferencia de una entrada de compra que puede costearse días
      // después de haberse recibido físicamente.
      fechaEntrada: Date.now(),
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

  // Capa de Triturado que este cierre generó. Un recierre previo puede
  // haber dejado capas de rondas anteriores ya voided (agotada:true) con
  // el mismo cierreTurnoId — hay que encontrar la que sigue "viva" (sin
  // revertir todavía).
  //
  // EDS-71 (auditoría de PR2): la versión original elegía "la más
  // reciente" comparando `createdAt` (Date.now() propio de la app) — un
  // auditor señaló que dos operaciones en el mismo milisegundo podrían
  // empatar y elegir la capa equivocada. Se reemplaza por selección
  // explícita: la capa viva es, por construcción, la ÚNICA que todavía no
  // tiene un movimiento `reversa_generacion` en su ledger (cada recaptura
  // revierte la capa vieja ANTES de crear la nueva — ver
  // recapturarCierreImpl más abajo). No depende de ningún orden temporal.
  // Si por algún motivo aparece más de una capa viva a la vez, es una
  // violación real de esa invariante — se falla explícito en vez de
  // adivinar cuál usar.
  const capasTriturado = await ctx.db
    .query('capasCosto')
    .withIndex('by_cierreTurnoId_origen', (q) => q.eq('cierreTurnoId', args.cierreTurnoId).eq('origen', 'triturado'))
    .collect();
  const candidatos = await Promise.all(
    capasTriturado.map(async (capa) => {
      const movimientos = await ctx.db
        .query('capaMovimientos')
        .withIndex('by_capaId', (q) => q.eq('capaId', capa._id))
        .collect();
      return { capa, movimientos, voided: movimientos.some((m) => m.tipo === 'reversa_generacion') };
    })
  );
  const vivas = candidatos.filter((c) => !c.voided);
  if (vivas.length > 1) {
    throw new Error(
      `revertirCierre: hay más de una capa de Triturado sin revertir para el cierre ${args.cierreTurnoId} — estado inconsistente, requiere revisión manual.`
    );
  }
  const capaViva = vivas[0] ?? null;

  if (capaViva) {
    // Consumo NETO, no solo "¿existe algún movimiento tipo consumo?" —
    // nada se borra en este sistema, así que un consumo ya revertido
    // sigue viéndose en el historial para siempre. Sin descontar la
    // reversa, un cierre posterior que consumió y luego revirtió esta
    // capa dejaría bloqueada la reversión de ESTE cierre para siempre.
    const consumoNeto = capaViva.movimientos.reduce((neto, m) => {
      if (m.tipo === 'consumo') return neto + m.kg;
      if (m.tipo === 'reversa_consumo') return neto - m.kg;
      return neto;
    }, 0);

    if (consumoNeto > 0) {
      throw new Error(
        `Este cierre no se puede revertir: el Triturado que generó tiene ${consumoNeto}kg consumidos (netos) por un cierre posterior — revierte ese cierre primero.`
      );
    }

    await ctx.db.patch(capaViva.capa._id, { kgRestante: 0, agotada: true });
    await ctx.db.insert('capaMovimientos', {
      capaId: capaViva.capa._id,
      materialId: capaViva.capa.materialId,
      tipo: 'reversa_generacion',
      kg: capaViva.capa.kgOriginal,
      costoUnitario: capaViva.capa.costoUnitario,
      origenTipo: 'correccion',
      origenId: String(args.cierreTurnoId),
      createdAt: Date.now(),
      createdBy: args.createdBy,
    });
  }

  return { ok: true };
}

// Glue compartida por 4.2 (recierre de un turno ya cerrado) y 5.2
// (corrección administrativa) — ambos casos son exactamente "revertir lo
// que había, aplicar los valores nuevos, y dejar auditoría de qué cambió y
// por qué". Antes de esto, esa secuencia iba a estar duplicada en cierres.ts
// y correcciones.ts; ahora ambos son wrappers delgados sobre esta función.
export async function recapturarCierreImpl(
  ctx: MutationCtx,
  args: {
    cierreTurnoId: Id<'cierresTurno'>;
    cargasPreparadas: number;
    metrosBuenos: number;
    caballetes105Pzas: number;
    caballetes106Pzas: number;
    consumoPorMaterial: { materialId: Id<'materiales'>; kgConsumido: number }[];
    motivo: 'recierre_duplicado' | 'correccion_manual';
    nota: string | null;
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
  if (args.cargasPreparadas < 0) {
    throw new Error('recapturarCierre: cargasPreparadas no puede ser negativo.');
  }

  const existente = await ctx.db.get(args.cierreTurnoId);
  if (!existente) {
    throw new Error(`recapturarCierre: cierresTurno ${args.cierreTurnoId} no existe.`);
  }
  const snapshotAntes = JSON.stringify(existente);

  // revertirCierreImpl es quien decide si esto es seguro (falla explícito
  // si el Triturado que este cierre generó ya fue consumido por otro
  // cierre posterior) — recapturarCierreImpl no repite esa lógica, solo la
  // usa: si revertir falla, este throw también falla y nada se escribe
  // (atomicidad de la mutation).
  await revertirCierreImpl(ctx, { cierreTurnoId: args.cierreTurnoId, createdBy: args.createdBy });

  const totales = await aplicarCierreImpl(ctx, {
    cierreTurnoId: args.cierreTurnoId,
    metrosBuenos: args.metrosBuenos,
    caballetes105Pzas: args.caballetes105Pzas,
    caballetes106Pzas: args.caballetes106Pzas,
    consumoPorMaterial: args.consumoPorMaterial,
    createdBy: args.createdBy,
  });

  const now = Date.now();
  await ctx.db.patch(args.cierreTurnoId, {
    cargasPreparadas: args.cargasPreparadas,
    metrosBuenos: args.metrosBuenos,
    caballetes105Pzas: args.caballetes105Pzas,
    caballetes106Pzas: args.caballetes106Pzas,
    ...totales,
    editado: true,
    editadoPor: args.createdBy,
    editadoEn: now,
    vecesRecapturado: existente.vecesRecapturado + 1,
  });

  const actualizado = await ctx.db.get(args.cierreTurnoId);
  const snapshotDespues = JSON.stringify(actualizado);

  await ctx.db.insert('correccionesHistorial', {
    entidad: 'cierreTurno',
    entidadId: String(args.cierreTurnoId),
    motivo: args.motivo,
    snapshotAntes,
    snapshotDespues,
    nota: args.nota,
    corregidoPor: args.createdBy,
    corregidoEn: now,
  });

  return totales;
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

export const recapturarCierre = internalMutation({
  args: {
    cierreTurnoId: v.id('cierresTurno'),
    cargasPreparadas: v.number(),
    metrosBuenos: v.number(),
    caballetes105Pzas: v.number(),
    caballetes106Pzas: v.number(),
    consumoPorMaterial: v.array(v.object({ materialId: v.id('materiales'), kgConsumido: v.number() })),
    motivo: v.union(v.literal('recierre_duplicado'), v.literal('correccion_manual')),
    nota: v.union(v.string(), v.null()),
    createdBy: v.id('users'),
  },
  handler: async (ctx, args) => recapturarCierreImpl(ctx, args),
});
