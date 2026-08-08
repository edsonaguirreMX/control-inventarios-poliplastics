import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireRole } from './lib/auth';
import { recapturarCierreImpl } from './cierreEngine';

const VENTANA_DIAS = 10;

function fechaISO(offsetDias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDias);
  return d.toISOString().slice(0, 10);
}

// Day-strip de los últimos 10 días — la ventana de corrección del spec.
// Admin-only, igual que toda la pantalla de Corrección de Capturas.
export const listRegistrosUltimos10Dias = query({
  args: { tipo: v.union(v.literal('cierre'), v.literal('entrada')), token: v.string() },
  handler: async (ctx, { tipo, token }) => {
    await requireRole(ctx, token, ['admin']);
    const dias = Array.from({ length: VENTANA_DIAS }, (_, i) => fechaISO(VENTANA_DIAS - 1 - i));
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

    if (args.cantidadKg <= 0) {
      throw new Error('actualizarEntrada: cantidadKg debe ser mayor a 0.');
    }

    const entrada = await ctx.db.get(args.entradaId);
    if (!entrada) {
      throw new Error('actualizarEntrada: la entrada no existe.');
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
        throw new Error(
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

    return { ok: true };
  },
});
