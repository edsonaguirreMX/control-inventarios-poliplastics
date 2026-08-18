import { v, ConvexError } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { requireAcceso } from './lib/auth';

// Parámetros de Producción y Fórmula — pantalla admin-only. Fuente única
// de verdad de cargasPorTurno/turnosPorDia/kgPorMetro y de kgPorCarga por
// material; Catálogo (materiales.ts) y Cierre de turno (cierres.ts) leen
// de aquí, nunca guardan su propia copia.
//
// EDS-105 (Fase 2) — decisión explícita del usuario tras revisar la tabla
// de equivalencia: SOLO la LECTURA (getParametros) se comparte con
// catalogo-materiales (EDS-88 ya deja ver/derivar estos valores desde esa
// pantalla). La ESCRITURA (updateParametros/updateFormulaCarga/
// guardarParametrosCompleto) NO se comparte — queda restringida solo a
// 'parametros-produccion', a propósito, aunque hoy Catálogo también tenga
// un control que llama updateParametros (para lineasActivas, EDS-88): con
// roles fijos (solo 5, admin ve ambas pantallas) esto nunca importó, pero
// con roles personalizables un rol con acceso a Catálogo pero NO a
// Parámetros de Producción no debe poder editar parámetros globales de
// producción. Ese control de Catálogo queda pendiente de resolver en
// Fase 3/4 (frontend) — hoy solo admin lo usa y admin tiene bypassAcceso,
// así que no se rompe nada todavía, solo se cierra el hueco para roles
// futuros.
export const getParametros = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAcceso(ctx, token, ['catalogo-materiales', 'parametros-produccion']);
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
      lineasActivas: params.lineasActivas ?? 2,
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
  args: { cargasPorTurno?: number; turnosPorDia?: number; lineasActivas?: number; kgPorMetro?: number }
): Promise<void> {
  // > 0, no solo "no negativo": Catálogo (y ahora también Panel de
  // Control, EDS-88) derivan consumoDiario y punto de reorden
  // multiplicando por estos valores — dejarlos en 0 pondría todo el
  // reorden teórico en 0 y ocultaría necesidades reales de compra.
  if (args.cargasPorTurno !== undefined && args.cargasPorTurno <= 0) {
    throw new ConvexError('actualizarParametros: cargasPorTurno debe ser mayor a 0.');
  }
  if (args.turnosPorDia !== undefined && args.turnosPorDia <= 0) {
    throw new ConvexError('actualizarParametros: turnosPorDia debe ser mayor a 0.');
  }
  // EDS-88: 1 o 2 — el spec fija un máximo físico de 2 líneas (Lambrín/
  // Thermo-PVC fuera de alcance v1, mismo límite ya usado en
  // cierres.ts/entradas.ts). El usuario pidió poder bajarlo a 1 cuando
  // solo opera una línea, para no inflar el punto de reorden teórico.
  if (args.lineasActivas !== undefined && (!Number.isInteger(args.lineasActivas) || args.lineasActivas < 1 || args.lineasActivas > 2)) {
    throw new ConvexError('actualizarParametros: lineasActivas debe ser 1 o 2.');
  }
  if (args.kgPorMetro !== undefined && args.kgPorMetro <= 0) {
    throw new ConvexError('actualizarParametros: kgPorMetro debe ser mayor a 0 (se usa como divisor en cierres/dashboard).');
  }
  const params = await ctx.db.query('parametrosProduccion').first();
  if (!params) {
    throw new Error('actualizarParametros: no hay parámetros de producción configurados.');
  }
  const patch: Record<string, unknown> = { updatedAt: Date.now(), updatedBy: user._id };
  if (args.cargasPorTurno !== undefined) patch.cargasPorTurno = args.cargasPorTurno;
  if (args.turnosPorDia !== undefined) patch.turnosPorDia = args.turnosPorDia;
  if (args.lineasActivas !== undefined) patch.lineasActivas = args.lineasActivas;
  if (args.kgPorMetro !== undefined) patch.kgPorMetro = args.kgPorMetro;
  await ctx.db.patch(params._id, patch);
}

async function actualizarFormulaCargaImpl(
  ctx: MutationCtx,
  args: { materialId: Id<'materiales'>; kgPorCarga: number; nota?: string }
): Promise<void> {
  if (args.kgPorCarga < 0) {
    throw new ConvexError('actualizarFormulaCarga: kgPorCarga no puede ser negativo.');
  }
  const material = await ctx.db.get(args.materialId);
  if (!material) {
    throw new ConvexError('actualizarFormulaCarga: el material no existe.');
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
    throw new ConvexError('La fórmula completa no puede sumar 0 kg por carga — Catálogo derivaría consumos y puntos de reorden inválidos.');
  }
}

export const updateParametros = mutation({
  args: {
    cargasPorTurno: v.optional(v.number()),
    turnosPorDia: v.optional(v.number()),
    lineasActivas: v.optional(v.number()),
    kgPorMetro: v.optional(v.number()),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireAcceso(ctx, args.token, 'parametros-produccion');
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
    // Sin consumidor actual (superseded por guardarParametrosCompleto) —
    // mismo criterio de escritura restringida que updateParametros arriba.
    await requireAcceso(ctx, args.token, 'parametros-produccion');
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
    const user = await requireAcceso(ctx, args.token, 'parametros-produccion');
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
