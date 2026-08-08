import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { crearCapaImpl } from './peps';
import { requireRole, requireUser } from './lib/auth';

// Flujo de Entradas: el operador (en cierre-turno-propuestas.html, tarea
// 4.3/4.4) solo captura kg recibidos, sin costo — queda "pendiente" hasta
// que Compras/Admin la completa con costo/proveedor/folio en
// entradas-costeo.html, momento en el que SÍ se genera la capa PEPS (nunca
// antes: sin costo no hay capa que crear).

export const crearEntrada = mutation({
  args: {
    fecha: v.string(),
    materialId: v.id('materiales'),
    cantidadKg: v.number(),
    costoUnitario: v.optional(v.number()),
    proveedor: v.optional(v.string()),
    folio: v.optional(v.string()),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['operador', 'compras', 'admin']);

    if (args.cantidadKg <= 0) {
      throw new Error('crearEntrada: cantidadKg debe ser mayor a 0.');
    }
    if (args.costoUnitario !== undefined && args.costoUnitario < 0) {
      throw new Error('crearEntrada: costoUnitario no puede ser negativo.');
    }

    const now = Date.now();
    const vieneConCosto = args.costoUnitario !== undefined;

    const entradaId = await ctx.db.insert('entradas', {
      fecha: args.fecha,
      materialId: args.materialId,
      cantidadKg: args.cantidadKg,
      costoUnitario: vieneConCosto ? args.costoUnitario! : null,
      proveedor: args.proveedor ?? '',
      folio: args.folio ?? '',
      estado: vieneConCosto ? 'costeada' : 'pendiente',
      capaId: null,
      registradoPor: user._id,
      costeadoPor: vieneConCosto ? user._id : null,
      costeadoEn: vieneConCosto ? now : null,
      editado: false,
      editadoPor: null,
      editadoEn: null,
      createdAt: now,
    });

    if (vieneConCosto) {
      const capaId = await crearCapaImpl(ctx, {
        materialId: args.materialId,
        kgOriginal: args.cantidadKg,
        costoUnitario: args.costoUnitario!,
        origen: 'entrada',
        entradaId,
        cierreTurnoId: null,
        origenTipo: 'entrada',
        origenId: String(entradaId),
        createdBy: user._id,
      });
      await ctx.db.patch(entradaId, { capaId });
    }

    return entradaId;
  },
});

export const costearEntrada = mutation({
  args: {
    entradaId: v.id('entradas'),
    costoUnitario: v.number(),
    proveedor: v.optional(v.string()),
    folio: v.optional(v.string()),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['compras', 'admin']);

    if (args.costoUnitario < 0) {
      throw new Error('costearEntrada: costoUnitario no puede ser negativo.');
    }

    const entrada = await ctx.db.get(args.entradaId);
    if (!entrada) {
      throw new Error('costearEntrada: la entrada no existe.');
    }
    if (entrada.estado === 'costeada') {
      throw new Error(
        'Esta entrada ya fue costeada — para corregir su costo/cantidad usa Corrección de Capturas, no vuelvas a costearla.'
      );
    }

    const capaId = await crearCapaImpl(ctx, {
      materialId: entrada.materialId,
      kgOriginal: entrada.cantidadKg,
      costoUnitario: args.costoUnitario,
      origen: 'entrada',
      entradaId: args.entradaId,
      cierreTurnoId: null,
      origenTipo: 'entrada',
      origenId: String(args.entradaId),
      createdBy: user._id,
    });

    const now = Date.now();
    await ctx.db.patch(args.entradaId, {
      costoUnitario: args.costoUnitario,
      proveedor: args.proveedor ?? entrada.proveedor,
      folio: args.folio ?? entrada.folio,
      estado: 'costeada',
      capaId,
      costeadoPor: user._id,
      costeadoEn: now,
    });

    return { ok: true, capaId };
  },
});

export const listEntradas = query({
  args: { desde: v.optional(v.string()), hasta: v.optional(v.string()), token: v.string() },
  handler: async (ctx, { desde, hasta, token }) => {
    await requireUser(ctx, token);
    const entradas = await ctx.db
      .query('entradas')
      .withIndex('by_fecha', (q) => {
        if (desde !== undefined && hasta !== undefined) return q.gte('fecha', desde).lte('fecha', hasta);
        if (desde !== undefined) return q.gte('fecha', desde);
        if (hasta !== undefined) return q.lte('fecha', hasta);
        return q;
      })
      .order('desc')
      .collect();
    return entradas;
  },
});

export const listCapasVigentes = query({
  args: { materialId: v.optional(v.id('materiales')), token: v.string() },
  handler: async (ctx, { materialId, token }) => {
    await requireUser(ctx, token);
    if (materialId !== undefined) {
      return ctx.db
        .query('capasCosto')
        .withIndex('by_material_agotada', (q) => q.eq('materialId', materialId).eq('agotada', false))
        .collect();
    }
    return ctx.db
      .query('capasCosto')
      .filter((q) => q.eq(q.field('agotada'), false))
      .collect();
  },
});

// Lista liviana para poblar el selector de material de esta pantalla — no
// incluye Triturado (no se "compra", se genera internamente por merma) ni
// los campos calculados de Catálogo (%mezcla, reorden), que son de la
// Épica 2. Ordenada igual que el catálogo para que la lista se vea estable.
export const listMaterialesActivos = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireUser(ctx, token);
    const materiales = await ctx.db
      .query('materiales')
      .withIndex('by_activo_orden', (q) => q.eq('activo', true))
      .collect();
    return materiales.filter((m) => !m.esInterno);
  },
});

// Solo entradas que todavía no generaron capa — una vez costeada, se
// corrige (no se borra) desde Corrección de Capturas (Épica 5), porque
// borrarla dejaría un capaId apuntando a una capa huérfana.
export const eliminarEntradaPendiente = mutation({
  args: { entradaId: v.id('entradas'), token: v.string() },
  handler: async (ctx, { entradaId, token }) => {
    await requireRole(ctx, token, ['compras', 'admin']);
    const entrada = await ctx.db.get(entradaId);
    if (!entrada) {
      throw new Error('eliminarEntradaPendiente: la entrada no existe.');
    }
    if (entrada.estado !== 'pendiente' || entrada.capaId !== null) {
      throw new Error(
        'Solo se pueden eliminar entradas pendientes sin costear. Una entrada ya costeada se corrige desde Corrección de Capturas.'
      );
    }
    await ctx.db.delete(entradaId);
    return { ok: true };
  },
});
