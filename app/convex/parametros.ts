import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { requireRole } from './lib/auth';

// Parámetros de Producción y Fórmula — pantalla admin-only. Fuente única
// de verdad de cargasPorTurno/turnosPorDia/kgPorMetro y de kgPorCarga por
// material; Catálogo (materiales.ts) y Cierre de turno (cierres.ts) leen
// de aquí, nunca guardan su propia copia.
export const getParametros = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireRole(ctx, token, ['admin']);
    const params = await ctx.db.query('parametrosProduccion').first();
    if (!params) {
      throw new Error('getParametros: no hay parámetros de producción configurados (parametrosProduccion vacío).');
    }
    const materiales = await ctx.db.query('materiales').withIndex('by_activo_orden', (q) => q.eq('activo', true)).collect();
    const formula = await ctx.db.query('formulaCarga').collect();
    const formulaPorMaterial = new Map(formula.map((f) => [f.materialId, f]));

    return {
      cargasPorTurno: params.cargasPorTurno,
      turnosPorDia: params.turnosPorDia,
      kgPorMetro: params.kgPorMetro,
      formula: materiales.map((m) => ({
        materialId: m._id,
        nombre: m.nombre,
        variante: m.variante,
        esSustituto: m.esSustituto,
        esInterno: m.esInterno,
        kgPorCarga: formulaPorMaterial.get(m._id)?.kgPorCarga ?? 0,
        nota: formulaPorMaterial.get(m._id)?.nota ?? '',
      })),
    };
  },
});

async function actualizarParametrosImpl(
  ctx: MutationCtx,
  user: { _id: Id<'users'> },
  args: { cargasPorTurno?: number; turnosPorDia?: number; kgPorMetro?: number }
): Promise<void> {
  // > 0, no solo "no negativo": Catálogo deriva consumoDiario y punto de
  // reorden multiplicando por estos valores — dejarlos en 0 pondría todo
  // el reorden teórico en 0 y ocultaría necesidades reales de compra.
  if (args.cargasPorTurno !== undefined && args.cargasPorTurno <= 0) {
    throw new Error('actualizarParametros: cargasPorTurno debe ser mayor a 0.');
  }
  if (args.turnosPorDia !== undefined && args.turnosPorDia <= 0) {
    throw new Error('actualizarParametros: turnosPorDia debe ser mayor a 0.');
  }
  if (args.kgPorMetro !== undefined && args.kgPorMetro <= 0) {
    throw new Error('actualizarParametros: kgPorMetro debe ser mayor a 0 (se usa como divisor en cierres/dashboard).');
  }
  const params = await ctx.db.query('parametrosProduccion').first();
  if (!params) {
    throw new Error('actualizarParametros: no hay parámetros de producción configurados.');
  }
  const patch: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: user._id };
  if (args.cargasPorTurno !== undefined) patch.cargasPorTurno = args.cargasPorTurno;
  if (args.turnosPorDia !== undefined) patch.turnosPorDia = args.turnosPorDia;
  if (args.kgPorMetro !== undefined) patch.kgPorMetro = args.kgPorMetro;
  await ctx.db.patch(params._id, patch);
}

async function actualizarFormulaCargaImpl(
  ctx: MutationCtx,
  args: { materialId: Id<'materiales'>; kgPorCarga: number; nota?: string }
): Promise<void> {
  if (args.kgPorCarga < 0) {
    throw new Error('actualizarFormulaCarga: kgPorCarga no puede ser negativo.');
  }
  const material = await ctx.db.get(args.materialId);
  if (!material) {
    throw new Error('actualizarFormulaCarga: el material no existe.');
  }
  const existente = await ctx.db.query('formulaCarga').withIndex('by_materialId', (q) => q.eq('materialId', args.materialId)).unique();
  const now = Date.now();
  if (existente) {
    await ctx.db.patch(existente._id, {
      kgPorCarga: args.kgPorCarga,
      nota: args.nota ?? existente.nota,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert('formulaCarga', {
      materialId: args.materialId,
      kgPorCarga: args.kgPorCarga,
      nota: args.nota ?? '',
      updatedAt: now,
    });
  }
}

// Se llama al FINAL de una transacción que tocó formulaCarga (nunca fila
// por fila dentro de un loop — un batch legítimo puede pasar por un total
// intermedio de 0 entre filas antes de terminar). Si el total quedara en 0,
// Catálogo derivaría %mezcla/consumoDiario/reorden inválidos para TODOS los
// materiales, no solo el que se editó.
//
// Solo cuentan los materiales ACTIVOS (hallazgo no bloqueante de la
// auditoría de PR6): hoy esta épica no tiene flujo para desactivar
// materiales, así que en la práctica todos están activos — pero la regla
// debe ser correcta desde ahora, no solo mientras esa condición se
// mantenga. Sin este filtro, una fórmula donde todos los materiales
// EN USO suman 0 podría "salvarse" con kgPorCarga>0 en un material ya
// desactivado, que ninguna pantalla real usa para calcular nada.
async function verificarFormulaTotalPositiva(ctx: MutationCtx): Promise<void> {
  const formula = await ctx.db.query('formulaCarga').collect();
  const materialesActivos = new Set(
    (await ctx.db.query('materiales').withIndex('by_activo_orden', (q) => q.eq('activo', true)).collect()).map((m) => m._id)
  );
  const total = formula
    .filter((f) => materialesActivos.has(f.materialId))
    .reduce((s, f) => s + f.kgPorCarga, 0);
  if (total <= 0) {
    throw new Error('La fórmula completa no puede sumar 0 kg por carga — Catálogo derivaría consumos y puntos de reorden inválidos.');
  }
}

export const updateParametros = mutation({
  args: {
    cargasPorTurno: v.optional(v.number()),
    turnosPorDia: v.optional(v.number()),
    kgPorMetro: v.optional(v.number()),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['admin']);
    await actualizarParametrosImpl(ctx, user, args);
    return { ok: true };
  },
});

export const updateFormulaCarga = mutation({
  args: {
    materialId: v.id('materiales'),
    kgPorCarga: v.number(),
    nota: v.optional(v.string()),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.token, ['admin']);
    await actualizarFormulaCargaImpl(ctx, args);
    await verificarFormulaTotalPositiva(ctx);
    return { ok: true };
  },
});

// Guarda cargasPorTurno/turnosPorDia/kgPorMetro y toda la fórmula (varios
// materiales) en UNA sola transacción de Convex. La pantalla de Parámetros
// tiene un solo botón "Guardar cambios" para todo el formulario — antes
// de esta mutation, guardarlo habría significado un loop de mutations
// independientes desde el cliente (1 por parámetro + 1 por material de la
// fórmula): si una fallara a la mitad, las anteriores ya habrían quedado
// escritas aunque la UI mostrara error (mismo guardado parcial que ya se
// corrigió en PR 3 para entradas/correcciones). Con esta mutation, o se
// guarda todo o no se guarda nada.
export const guardarParametrosCompleto = mutation({
  args: {
    cargasPorTurno: v.number(),
    turnosPorDia: v.number(),
    kgPorMetro: v.number(),
    formula: v.array(v.object({
      materialId: v.id('materiales'),
      kgPorCarga: v.number(),
      nota: v.optional(v.string()),
    })),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['admin']);
    await actualizarParametrosImpl(ctx, user, {
      cargasPorTurno: args.cargasPorTurno,
      turnosPorDia: args.turnosPorDia,
      kgPorMetro: args.kgPorMetro,
    });
    for (const fila of args.formula) {
      await actualizarFormulaCargaImpl(ctx, fila);
    }
    await verificarFormulaTotalPositiva(ctx);
    return { ok: true };
  },
});
