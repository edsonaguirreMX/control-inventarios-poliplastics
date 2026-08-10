import { v, ConvexError } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { requireRole } from './lib/auth';
import { recapturarCierreImpl } from './cierreEngine';
import { fechaOperativa, sumarDiasISO } from './lib/fechaOperativa';

const VENTANA_DIAS = 10;

// La ventana de corrección se ancla a la fecha operativa real (huso de
// parametrosProduccion.zonaHoraria + regla de Turno 2 cruzando medianoche),
// nunca a new Date().toISOString() — mismo bloqueante de la auditoría de
// PR 3 que ya se corrigió para cierres/entradas (ver lib/fechaOperativa.ts).
async function ventanaUltimosDias(ctx: { db: { query: any } }, dias: number): Promise<string[]> {
  const params = await ctx.db.query('parametrosProduccion').first();
  if (!params) {
    throw new ConvexError('ventanaUltimosDias: no hay parámetros de producción configurados (parametrosProduccion vacío).');
  }
  const hoy = fechaOperativa(Date.now(), params.zonaHoraria, params.horaInicioTurno1);
  return Array.from({ length: dias }, (_, i) => sumarDiasISO(hoy, -(dias - 1 - i)));
}

// Day-strip de los últimos 10 días — la ventana de corrección del spec.
// Admin-only, igual que toda la pantalla de Corrección de Capturas.
export const listRegistrosUltimos10Dias = query({
  args: { tipo: v.union(v.literal('cierre'), v.literal('entrada')), token: v.string() },
  handler: async (ctx, { tipo, token }) => {
    await requireRole(ctx, token, ['admin']);
    const dias = await ventanaUltimosDias(ctx, VENTANA_DIAS);
    const resultado = [];
    for (const fecha of dias) {
      let tieneRegistro: boolean;
      if (tipo === 'cierre') {
        const cierre = await ctx.db.query('cierresTurno').withIndex('by_fecha', (q) => q.eq('fecha', fecha)).first();
        tieneRegistro = cierre !== null;
      } else {
        const entrada = await ctx.db.query('entradas').withIndex('by_fecha', (q) => q.eq('fecha', fecha)).first();
        tieneRegistro = entrada !== null;
      }
      resultado.push({ fecha, tieneRegistro });
    }
    return resultado;
  },
});

export const getCierre = query({
  args: { fecha: v.string(), linea: v.union(v.literal(1), v.literal(2)), turno: v.union(v.literal(1), v.literal(2)), token: v.string() },
  handler: async (ctx, { fecha, linea, turno, token }) => {
    await requireRole(ctx, token, ['admin']);
    const cierre = await ctx.db
      .query('cierresTurno')
      .withIndex('by_fecha_linea_turno', (q) => q.eq('fecha', fecha).eq('linea', linea).eq('turno', turno))
      .unique();
    if (!cierre) return null;
    const consumos = await ctx.db
      .query('cierreConsumos')
      .withIndex('by_cierreTurnoId_vigente', (q) => q.eq('cierreTurnoId', cierre._id).eq('vigente', true))
      .collect();
    return { cierre, consumos };
  },
});

export const getEntradasDelDia = query({
  args: { fecha: v.string(), token: v.string() },
  handler: async (ctx, { fecha, token }) => {
    await requireRole(ctx, token, ['admin']);
    return ctx.db.query('entradas').withIndex('by_fecha', (q) => q.eq('fecha', fecha)).collect();
  },
});

export const actualizarCierreTurno = mutation({
  args: {
    cierreTurnoId: v.id('cierresTurno'),
    cargasPreparadas: v.number(),
    metrosBuenos: v.number(),
    caballetes105Pzas: v.number(),
    caballetes106Pzas: v.number(),
    consumoPorMaterial: v.array(v.object({ materialId: v.id('materiales'), kgConsumido: v.number() })),
    nota: v.optional(v.string()),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['admin']);
    // recapturarCierreImpl hace revertir→aplicar→patch→auditoría — el
    // MISMO camino que usa el recierre de 4.2, no una segunda
    // implementación de la misma secuencia.
    const totales = await recapturarCierreImpl(ctx, {
      cierreTurnoId: args.cierreTurnoId,
      cargasPreparadas: args.cargasPreparadas,
      metrosBuenos: args.metrosBuenos,
      caballetes105Pzas: args.caballetes105Pzas,
      caballetes106Pzas: args.caballetes106Pzas,
      consumoPorMaterial: args.consumoPorMaterial,
      motivo: 'correccion_manual',
      nota: args.nota ?? null,
      createdBy: user._id,
    });
    return { ok: true, ...totales };
  },
});

// Cuerpo compartido de "corregir una entrada" — usado tanto por
// `actualizarEntrada` (una sola) como por `actualizarEntradasBatch` (varias
// a la vez, para cuando Corrección de Capturas edita varios renglones del
// mismo día). `user` ya viene resuelto por el caller — el rol se valida UNA
// vez por llamada a la mutation pública, no una vez por entrada del batch.
async function actualizarEntradaImpl(
  ctx: MutationCtx,
  user: { _id: Id<'users'> },
  args: { entradaId: Id<'entradas'>; cantidadKg: number; proveedor?: string; folio?: string; nota?: string }
): Promise<void> {
  if (args.cantidadKg <= 0) {
    throw new ConvexError('actualizarEntrada: cantidadKg debe ser mayor a 0.');
  }

  const entrada = await ctx.db.get(args.entradaId);
  if (!entrada) {
    throw new ConvexError('actualizarEntrada: la entrada no existe.');
  }

  const snapshotAntes = JSON.stringify(entrada);
  const now = Date.now();

  if (entrada.estado === 'pendiente' || !entrada.capaId) {
    // Sin capa todavía — es un ajuste simple, sin implicaciones PEPS.
    await ctx.db.patch(args.entradaId, {
      cantidadKg: args.cantidadKg,
      proveedor: args.proveedor ?? entrada.proveedor,
      folio: args.folio ?? entrada.folio,
      editado: true,
      editadoPor: user._id,
      editadoEn: now,
    });
  } else {
    // Ya tiene capa — el saldo nuevo es DETERMINÍSTICO
    // (cantidadNueva − kgYaConsumido), nunca proporcional, y se bloquea
    // duro si ya se consumió más de lo que la cantidad nueva permitiría.
    const capa = await ctx.db.get(entrada.capaId);
    if (!capa) {
      throw new Error('actualizarEntrada: la capa asociada a esta entrada no existe — inconsistencia de datos.');
    }
    const movimientos = await ctx.db.query('capaMovimientos').withIndex('by_capaId', (q) => q.eq('capaId', capa._id)).collect();
    const kgYaConsumido = movimientos.reduce((neto, m) => {
      if (m.tipo === 'consumo') return neto + m.kg;
      if (m.tipo === 'reversa_consumo') return neto - m.kg;
      return neto;
    }, 0);

    if (args.cantidadKg < kgYaConsumido) {
      // EDS-73: ConvexError — regla de negocio real, con la acción exacta
      // que el admin necesita tomar.
      throw new ConvexError(
        `No se puede reducir a ${args.cantidadKg}kg: ya se consumieron ${kgYaConsumido}kg de esta entrada en cierres posteriores — revierte esos cierres primero desde Corrección de Capturas.`
      );
    }

    const kgRestanteNuevo = args.cantidadKg - kgYaConsumido;
    const diferencia = args.cantidadKg - capa.kgOriginal;
    if (diferencia !== 0) {
      await ctx.db.insert('capaMovimientos', {
        capaId: capa._id,
        materialId: capa.materialId,
        tipo: diferencia > 0 ? 'ajuste_incremento' : 'ajuste_decremento',
        kg: Math.abs(diferencia),
        costoUnitario: capa.costoUnitario,
        origenTipo: 'correccion',
        origenId: String(args.entradaId),
        createdAt: now,
        createdBy: user._id,
      });
    }
    await ctx.db.patch(capa._id, {
      kgOriginal: args.cantidadKg,
      kgRestante: kgRestanteNuevo,
      agotada: kgRestanteNuevo <= 0,
    });

    await ctx.db.patch(args.entradaId, {
      cantidadKg: args.cantidadKg,
      proveedor: args.proveedor ?? entrada.proveedor,
      folio: args.folio ?? entrada.folio,
      editado: true,
      editadoPor: user._id,
      editadoEn: now,
    });
  }

  const actualizada = await ctx.db.get(args.entradaId);
  const snapshotDespues = JSON.stringify(actualizada);
  await ctx.db.insert('correccionesHistorial', {
    entidad: 'entrada',
    entidadId: String(args.entradaId),
    motivo: 'ajuste_cantidad',
    snapshotAntes,
    snapshotDespues,
    nota: args.nota ?? null,
    corregidoPor: user._id,
    corregidoEn: now,
  });
}

export const actualizarEntrada = mutation({
  args: {
    entradaId: v.id('entradas'),
    cantidadKg: v.number(),
    proveedor: v.optional(v.string()),
    folio: v.optional(v.string()),
    nota: v.optional(v.string()),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['compras', 'admin']);
    await actualizarEntradaImpl(ctx, user, args);
    return { ok: true };
  },
});

// Corrige varias entradas del mismo día en UNA sola transacción de Convex.
// Antes, la pantalla de Corrección de Capturas llamaba `actualizarEntrada`
// una vez por renglón editado desde el cliente: si la segunda de tres
// fallaba (p.ej. por el bloqueo de "ya se consumió más de lo permitido"),
// la primera ya había quedado corregida aunque la UI mostrara error
// (guardado parcial — mayor de la auditoría de PR 3, especialmente grave
// aquí porque es exactamente el escenario de corrección administrativa que
// debe ser auditable de forma atómica). Si cualquier entrada del batch
// falla su validación, Convex descarta la transacción completa.
export const actualizarEntradasBatch = mutation({
  args: {
    entradas: v.array(v.object({ entradaId: v.id('entradas'), cantidadKg: v.number() })),
    nota: v.optional(v.string()),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['compras', 'admin']);
    if (args.entradas.length === 0) {
      throw new ConvexError('actualizarEntradasBatch: se necesita al menos una entrada.');
    }
    for (const e of args.entradas) {
      await actualizarEntradaImpl(ctx, user, { entradaId: e.entradaId, cantidadKg: e.cantidadKg, nota: args.nota });
    }
    return { ok: true };
  },
});
