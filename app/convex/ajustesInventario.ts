import { v, ConvexError } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { crearCapaImpl, consumirFIFOImpl } from './peps';
import { requireRole } from './lib/auth';
import { requireParametros } from './dashboard';
import { fechaOperativa } from './lib/fechaOperativa';

// EDS-93 — ajustes manuales de inventario (entrada/salida), admin-only.
// Pedido explícito del usuario: llegan muestras (entrada) o se detecta que
// se consumió más o menos material del que quedó registrado vía los
// lotes/cierres (salida). A diferencia de un cierre de turno, un ajuste
// SIEMPRE se fecha con el día real de captura — nunca retrofechado, así
// que `fecha` se calcula server-side (fechaOperativa de "ahora"), nunca se
// recibe del cliente. Nada se edita ni se revierte una vez guardado — si
// algo se capturó mal, se corrige con un ajuste contrario (misma
// disciplina de auditoría que el resto del sistema).
//
// A propósito NO reutiliza entradas.ts (que bloquea Triturado — "se genera
// internamente por merma, no se registra como entrada de compra") ni
// entradas.listMaterialesActivos (que lo filtra) — el usuario confirmó
// explícitamente que los ajustes SÍ deben poder aplicarse a Triturado
// (ej. el conteo físico de merma reciclada no cuadra con lo calculado).

async function validarMaterialParaAjuste(ctx: MutationCtx, materialId: Id<'materiales'>) {
  const material = await ctx.db.get(materialId);
  if (!material) {
    throw new ConvexError('El material seleccionado no existe.');
  }
  if (!material.activo) {
    throw new ConvexError(`${material.nombre} no está activo en el catálogo — no se pueden registrar ajustes.`);
  }
  return material;
}

async function fechaHoyParaAjuste(ctx: MutationCtx): Promise<string> {
  const params = await requireParametros(ctx);
  return fechaOperativa(Date.now(), params.zonaHoraria, params.horaInicioTurno1);
}

export async function crearAjusteEntradaImpl(
  ctx: MutationCtx,
  args: { materialId: Id<'materiales'>; kg: number; costoUnitario: number; motivo: string; createdBy: Id<'users'> }
): Promise<Id<'ajustesInventario'>> {
  if (args.kg <= 0) {
    throw new ConvexError('crearAjusteEntrada: kg debe ser mayor a 0.');
  }
  if (args.costoUnitario < 0) {
    throw new ConvexError('crearAjusteEntrada: costoUnitario no puede ser negativo.');
  }
  const motivo = args.motivo.trim();
  if (motivo === '') {
    throw new ConvexError('crearAjusteEntrada: el motivo es obligatorio.');
  }
  await validarMaterialParaAjuste(ctx, args.materialId);

  const fecha = await fechaHoyParaAjuste(ctx);
  const now = Date.now();

  // Mismo patrón que cierreEngine.ts/cierres.ts: insertar el doc con los
  // campos derivados en su valor "vacío" primero (aquí capaId), obtener su
  // _id para usarlo como origenId de la capa, y hacer patch al final —
  // crearCapaImpl nunca escribe este doc directamente.
  const ajusteId = await ctx.db.insert('ajustesInventario', {
    materialId: args.materialId,
    tipo: 'entrada',
    kg: args.kg,
    motivo,
    fecha,
    costoUnitario: args.costoUnitario,
    costoTotal: args.kg * args.costoUnitario,
    capaId: null,
    capasDetalle: null,
    registradoPor: args.createdBy,
    createdAt: now,
  });

  const capaId = await crearCapaImpl(ctx, {
    materialId: args.materialId,
    kgOriginal: args.kg,
    costoUnitario: args.costoUnitario,
    // El ajuste entra al inventario exactamente en el momento en que se
    // captura — no hay una fecha de recepción distinta que rastrear (a
    // diferencia de una entrada de compra, que puede costearse días
    // después de haberse recibido físicamente).
    fechaEntrada: now,
    origen: 'ajusteManual',
    entradaId: null,
    cierreTurnoId: null,
    origenTipo: 'ajusteManual',
    origenId: String(ajusteId),
    createdBy: args.createdBy,
  });
  await ctx.db.patch(ajusteId, { capaId });

  return ajusteId;
}

export async function crearAjusteSalidaImpl(
  ctx: MutationCtx,
  args: { materialId: Id<'materiales'>; kg: number; motivo: string; createdBy: Id<'users'> }
): Promise<Id<'ajustesInventario'>> {
  if (args.kg <= 0) {
    throw new ConvexError('crearAjusteSalida: kg debe ser mayor a 0.');
  }
  const motivo = args.motivo.trim();
  if (motivo === '') {
    throw new ConvexError('crearAjusteSalida: el motivo es obligatorio.');
  }
  const material = await validarMaterialParaAjuste(ctx, args.materialId);

  // consumirFIFOImpl deja pasar un faltante SIN bloquear cuando el
  // material es Triturado (esInterno) — correcto para el consumo real de
  // producción (es física normal de la operación), pero NO para un ajuste
  // manual: aquí no hay justificación física para "inventar" un faltante,
  // solo sería un error de captura del admin. Por eso este guard corre
  // ANTES de llamar a consumirFIFOImpl y bloquea sin excepción alguna,
  // sin tocar peps.ts (que sigue sirviendo correctamente al cierre de turno).
  const capas = await ctx.db
    .query('capasCosto')
    .withIndex('by_material_agotada', (q) => q.eq('materialId', args.materialId).eq('agotada', false))
    .collect();
  const existencia = capas.reduce((s, c) => s + c.kgRestante, 0);
  if (args.kg > existencia) {
    throw new ConvexError(
      `Existencia insuficiente de ${material.nombre} (${material.variante}): disponible ${existencia}kg, se intenta retirar ${args.kg}kg.`
    );
  }

  const fecha = await fechaHoyParaAjuste(ctx);
  const now = Date.now();

  const ajusteId = await ctx.db.insert('ajustesInventario', {
    materialId: args.materialId,
    tipo: 'salida',
    kg: args.kg,
    motivo,
    fecha,
    costoUnitario: null,
    costoTotal: 0, // placeholder — se reemplaza abajo con el costo real de las capas consumidas
    capaId: null,
    capasDetalle: null,
    registradoPor: args.createdBy,
    createdAt: now,
  });

  const resultado = await consumirFIFOImpl(ctx, {
    materialId: args.materialId,
    kgAConsumir: args.kg,
    origenTipo: 'ajusteManual',
    origenId: String(ajusteId),
    createdBy: args.createdBy,
  });

  // No debería poder pasar (ya se validó existencia arriba, dentro de la
  // misma transacción) — si pasa, es una violación real de esa invariante,
  // no un caso normal a tolerar en silencio.
  if (resultado.faltanteKg > 0) {
    throw new Error(
      `crearAjusteSalida: consumirFIFOImpl reportó un faltante de ${resultado.faltanteKg}kg pese a la validación previa de existencia — inconsistencia de datos, revisar antes de continuar.`
    );
  }

  await ctx.db.patch(ajusteId, { costoTotal: resultado.costoTotal, capasDetalle: resultado.capasDetalle });

  return ajusteId;
}

export const crearAjusteEntrada = mutation({
  args: { materialId: v.id('materiales'), kg: v.number(), costoUnitario: v.number(), motivo: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['admin']);
    const ajusteId = await crearAjusteEntradaImpl(ctx, { ...args, createdBy: user._id });
    return { ok: true, ajusteId };
  },
});

export const crearAjusteSalida = mutation({
  args: { materialId: v.id('materiales'), kg: v.number(), motivo: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['admin']);
    const ajusteId = await crearAjusteSalidaImpl(ctx, { ...args, createdBy: user._id });
    return { ok: true, ajusteId };
  },
});

// Reporte por rango de fechas (EDS-93/94) — "desde"/"hasta" inclusive,
// mismo formato "YYYY-MM-DD" que el resto del sistema. Resuelve
// nombre/variante de material y nombre de quién lo capturó para que el
// cliente no tenga que hacer N queries adicionales.
export const listAjustes = query({
  args: { desde: v.string(), hasta: v.string(), token: v.string() },
  handler: async (ctx, { desde, hasta, token }) => {
    await requireRole(ctx, token, ['admin']);
    const ajustes = await ctx.db
      .query('ajustesInventario')
      .withIndex('by_fecha', (q) => q.gte('fecha', desde).lte('fecha', hasta))
      .collect();

    const materialIds = [...new Set(ajustes.map((a) => a.materialId))];
    const materiales = await Promise.all(materialIds.map((id) => ctx.db.get(id)));
    const materialPorId = new Map(materiales.filter((m) => m !== null).map((m) => [m!._id, m!]));

    const userIds = [...new Set(ajustes.map((a) => a.registradoPor))];
    const usuarios = await Promise.all(userIds.map((id) => ctx.db.get(id)));
    const usuarioPorId = new Map(usuarios.filter((u) => u !== null).map((u) => [u!._id, u!]));

    return ajustes
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((a) => {
        const material = materialPorId.get(a.materialId);
        return {
          _id: a._id,
          fecha: a.fecha,
          materialId: a.materialId,
          nombre: material?.nombre ?? '?',
          variante: material?.variante ?? '',
          tipo: a.tipo,
          kg: a.kg,
          costoUnitario: a.costoUnitario,
          costoTotal: a.costoTotal,
          motivo: a.motivo,
          registradoPorNombre: usuarioPorId.get(a.registradoPor)?.nombre ?? '?',
          createdAt: a.createdAt,
        };
      });
  },
});

// Selector de material del formulario — a diferencia de
// entradas.listMaterialesActivos, SÍ incluye Triturado (esInterno):
// decisión explícita del usuario, los ajustes aplican a todo el catálogo.
export const listMaterialesParaAjuste = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireRole(ctx, token, ['admin']);
    return ctx.db.query('materiales').withIndex('by_activo_orden', (q) => q.eq('activo', true)).collect();
  },
});
