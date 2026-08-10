import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { requireRole } from './lib/auth';

// El spec fija exactamente 2 líneas (Lambrín/Thermo-PVC quedan fuera de
// alcance v1) — mismo hardcode ya usado en cierres.ts/entradas.ts, no una
// tabla configurable.
const NUM_LINEAS = 2;

// Catálogo de Materiales — pantalla admin-only (mismo guard que la
// página). %mezcla, consumo diario y punto de reorden se calculan aquí en
// vivo a partir de formulaCarga/parametrosProduccion, NUNCA se guardan:
// así Catálogo y Parámetros no pueden divergir entre sí.
//
// El "consumo diario" de esta pantalla es TEÓRICO — de planeación
// (kgPorCarga × cargasPorTurno × turnosPorDia × 2 líneas), y cambia de
// inmediato al editar Parámetros de Producción, sin depender de cierres
// reales. Es DISTINTO, a propósito, del consumo diario PROMEDIO REAL que
// usa panel-control.html (dashboard.getKPIsHoy) para su propio punto de
// reorden — ese sí se deriva del historial real de cierreConsumos. Cada
// pantalla sirve un propósito distinto (planeación vs. monitoreo
// operativo) y pueden mostrar un punto de reorden distinto para el mismo
// material — la UI de Catálogo lo etiqueta explícitamente como "de
// planeación" para que esto nunca se lea como una divergencia/bug.
export const listCatalogo = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireRole(ctx, token, ['admin']);
    const params = await ctx.db.query('parametrosProduccion').first();
    if (!params) {
      throw new Error('listCatalogo: no hay parámetros de producción configurados (parametrosProduccion vacío).');
    }
    const materiales = await ctx.db.query('materiales').withIndex('by_activo_orden', (q) => q.eq('activo', true)).collect();
    const formula = await ctx.db.query('formulaCarga').collect();
    const formulaPorMaterial = new Map(formula.map((f) => [f.materialId, f]));
    const totalKgPorCarga = formula.reduce((s, f) => s + f.kgPorCarga, 0);

    return materiales.map((m) => {
      const kgPorCarga = formulaPorMaterial.get(m._id)?.kgPorCarga ?? 0;
      const formulaPct = totalKgPorCarga > 0 ? (kgPorCarga / totalKgPorCarga) * 100 : 0;
      const consumoDiario = kgPorCarga * params.cargasPorTurno * params.turnosPorDia * NUM_LINEAS;

      const sinReorden = m.esInterno || m.esSustituto;
      let reorderCalc: number | null = null;
      let reorderEnUso: number | null = null;
      if (!sinReorden) {
        const stockSeguridad = m.stockSeguridadDias ?? 7;
        const leadTime = m.leadTimeDias ?? 0;
        reorderCalc = consumoDiario * (leadTime + stockSeguridad);
        reorderEnUso = m.reorderMode === 'manual' && m.reorderManualKg !== null ? m.reorderManualKg : reorderCalc;
      }

      return {
        materialId: m._id,
        slug: m.slug,
        nombre: m.nombre,
        variante: m.variante,
        esInterno: m.esInterno,
        esSustituto: m.esSustituto,
        costoEstandar: m.costoEstandar,
        leadTimeDias: m.leadTimeDias,
        stockSeguridadDias: m.stockSeguridadDias,
        reorderMode: m.reorderMode,
        reorderManualKg: m.reorderManualKg,
        cantidadPedirKg: m.cantidadPedirKg,
        kgPorCarga,
        formulaPct,
        consumoDiario,
        reorderCalc,
        reorderEnUso,
      };
    });
  },
});

type ActualizarMaterialArgs = {
  materialId: Id<'materiales'>;
  costoEstandar?: number;
  leadTimeDias?: number | null;
  stockSeguridadDias?: number | null;
  reorderMode?: 'auto' | 'manual';
  reorderManualKg?: number | null;
  cantidadPedirKg?: number | null;
};

async function actualizarMaterialImpl(ctx: MutationCtx, user: { _id: Id<'users'> }, args: ActualizarMaterialArgs): Promise<void> {
  const material = await ctx.db.get(args.materialId);
  if (!material) {
    throw new Error('updateMaterial: el material no existe.');
  }

  // Regla de negocio no negociable (spec, regla 2): Triturado reingresa
  // a inventario valuado en $0 — nunca editable, ni por admin.
  if (material.esInterno && args.costoEstandar !== undefined && args.costoEstandar !== 0) {
    throw new Error('El costo de Triturado (material interno) siempre es $0 — no se puede editar.');
  }
  if (args.costoEstandar !== undefined && args.costoEstandar < 0) {
    throw new Error('updateMaterial: costoEstandar no puede ser negativo.');
  }
  if (args.leadTimeDias != null && args.leadTimeDias < 0) {
    throw new Error('updateMaterial: leadTimeDias no puede ser negativo.');
  }
  if (args.stockSeguridadDias != null && args.stockSeguridadDias < 0) {
    throw new Error('updateMaterial: stockSeguridadDias no puede ser negativo.');
  }
  if (args.reorderManualKg != null && args.reorderManualKg < 0) {
    throw new Error('updateMaterial: reorderManualKg no puede ser negativo.');
  }
  if (args.cantidadPedirKg != null && args.cantidadPedirKg < 0) {
    throw new Error('updateMaterial: cantidadPedirKg no puede ser negativo.');
  }

  const patch: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: user._id };
  if (args.costoEstandar !== undefined) patch.costoEstandar = args.costoEstandar;
  if (args.leadTimeDias !== undefined) patch.leadTimeDias = args.leadTimeDias;
  if (args.stockSeguridadDias !== undefined) patch.stockSeguridadDias = args.stockSeguridadDias;
  if (args.reorderMode !== undefined) patch.reorderMode = args.reorderMode;
  if (args.reorderManualKg !== undefined) patch.reorderManualKg = args.reorderManualKg;
  if (args.cantidadPedirKg !== undefined) patch.cantidadPedirKg = args.cantidadPedirKg;

  await ctx.db.patch(args.materialId, patch);
}

export const updateMaterial = mutation({
  args: {
    materialId: v.id('materiales'),
    costoEstandar: v.optional(v.number()),
    leadTimeDias: v.optional(v.union(v.number(), v.null())),
    stockSeguridadDias: v.optional(v.union(v.number(), v.null())),
    reorderMode: v.optional(v.union(v.literal('auto'), v.literal('manual'))),
    reorderManualKg: v.optional(v.union(v.number(), v.null())),
    cantidadPedirKg: v.optional(v.union(v.number(), v.null())),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['admin']);
    await actualizarMaterialImpl(ctx, user, args);
    return { ok: true };
  },
});

// Guarda varios materiales del catálogo en UNA sola transacción — la
// pantalla tiene un solo botón "Guardar cambios" para toda la tabla; un
// loop de mutations independientes desde el cliente dejaría un guardado
// parcial si un material a la mitad del loop fallara su validación
// (mismo bloqueante ya corregido en PR 3 para entradas/correcciones).
export const guardarCatalogoCompleto = mutation({
  args: {
    materiales: v.array(v.object({
      materialId: v.id('materiales'),
      costoEstandar: v.optional(v.number()),
      leadTimeDias: v.optional(v.union(v.number(), v.null())),
      stockSeguridadDias: v.optional(v.union(v.number(), v.null())),
      reorderMode: v.optional(v.union(v.literal('auto'), v.literal('manual'))),
      reorderManualKg: v.optional(v.union(v.number(), v.null())),
      cantidadPedirKg: v.optional(v.union(v.number(), v.null())),
    })),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['admin']);
    if (args.materiales.length === 0) {
      throw new Error('guardarCatalogoCompleto: se necesita al menos un material.');
    }
    for (const fila of args.materiales) {
      await actualizarMaterialImpl(ctx, user, fila);
    }
    return { ok: true };
  },
});
