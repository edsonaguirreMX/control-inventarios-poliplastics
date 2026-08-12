import { v, ConvexError } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { crearCapaImpl } from './peps';
import { requireRole, requireUser } from './lib/auth';
import { validarFechaOperativaEnVentana } from './lib/fechaOperativa';

// Flujo de Entradas: el operador (en cierre-turno-propuestas.html, tarea
// 4.3/4.4) solo captura kg recibidos, sin costo — queda "pendiente" hasta
// que Compras/Admin la completa con costo/proveedor/folio en
// entradas-costeo.html, momento en el que SÍ se genera la capa PEPS (nunca
// antes: sin costo no hay capa que crear).

// entrada.fecha es "YYYY-MM-DD" (fecha REAL de recepción, capturada por
// quien registra la entrada) — la capa PEPS debe ordenarse por esa fecha,
// nunca por cuándo alguien tecleó el costo días después. Se interpreta a
// medianoche UTC: no importa la hora exacta, solo el orden entre fechas.
function fechaStringATimestamp(fecha: string): number {
  const ms = Date.parse(`${fecha}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new ConvexError(`Fecha inválida: "${fecha}" (se espera formato YYYY-MM-DD).`);
  }
  return ms;
}

async function validarMaterialParaEntrada(ctx: { db: { get: (id: any) => Promise<any> } }, materialId: any) {
  const material = await ctx.db.get(materialId);
  if (!material) {
    throw new ConvexError('El material seleccionado no existe.');
  }
  if (!material.activo) {
    throw new ConvexError(`${material.nombre} no está activo en el catálogo — no se pueden registrar entradas.`);
  }
  if (material.esInterno) {
    throw new ConvexError(`${material.nombre} se genera internamente por merma — no se registra como entrada de compra.`);
  }
  return material;
}

// Cuerpo compartido de "crear una entrada" — usado tanto por `crearEntrada`
// (una sola, con costo opcional, para Compras/Admin en entradas-costeo.html)
// como por `crearEntradasBatch` (varias a la vez, siempre sin costo, para
// el flujo del operador en cierre-turno-propuestas.html). `user` ya viene
// resuelto por el caller — el rol se valida UNA vez por llamada a la
// mutation pública, no una vez por material dentro del batch.
async function crearEntradaImpl(
  ctx: MutationCtx,
  user: { _id: Id<'users'>; rol: string },
  args: {
    fecha: string;
    materialId: Id<'materiales'>;
    cantidadKg: number;
    costoUnitario?: number;
    proveedor?: string;
    folio?: string;
  }
): Promise<Id<'entradas'>> {
  if (args.cantidadKg <= 0) {
    throw new ConvexError('crearEntrada: cantidadKg debe ser mayor a 0.');
  }
  const vieneConCosto = args.costoUnitario !== undefined;
  if (vieneConCosto && args.costoUnitario! < 0) {
    throw new ConvexError('crearEntrada: costoUnitario no puede ser negativo.');
  }
  // Un operador solo captura kg — costear (aunque sea en el mismo acto de
  // crear) es decisión de Compras/Admin. Sin este bloqueo, un operador
  // podría crear capas PEPS con costo arbitrario llamando la API directo.
  if (vieneConCosto && user.rol === 'operador') {
    throw new ConvexError(
      'Un operador no puede capturar el costo de una entrada — guarda solo la cantidad; Compras la completará después.'
    );
  }

  await validarMaterialParaEntrada(ctx, args.materialId);

  const now = Date.now();
  const fechaEntrada = fechaStringATimestamp(args.fecha);

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
      fechaEntrada,
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
}

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
    const params = await ctx.db.query('parametrosProduccion').first();
    if (!params) {
      throw new Error('crearEntrada: no hay parámetros de producción configurados.');
    }
    // EDS-83: a diferencia de un cierre de turno, SÍ es normal registrar
    // tarde el papeleo de una entrada real vieja — solo se valida formato
    // y que no sea futura, sin límite hacia atrás (diasAtras: null).
    validarFechaOperativaEnVentana(args.fecha, params.zonaHoraria, params.horaInicioTurno1, null);
    return crearEntradaImpl(ctx, user, args);
  },
});

// Crea varias entradas (sin costo — el operador nunca lo captura) en UNA
// sola transacción de Convex. Antes, el flujo de "Entrada de material"
// llamaba `crearEntrada` una vez por material desde el cliente: si la
// tercera de cinco fallaba, las dos primeras ya habían quedado guardadas
// aunque la UI mostrara error (guardado parcial — mayor de la auditoría de
// PR 3). Con esta mutation, si CUALQUIER material falla su validación, la
// mutation entera lanza y Convex descarta la transacción completa: no
// queda ninguna entrada de este batch a medio guardar.
export const crearEntradasBatch = mutation({
  args: {
    fecha: v.string(),
    materiales: v.array(v.object({ materialId: v.id('materiales'), cantidadKg: v.number() })),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['operador', 'compras', 'admin']);
    if (args.materiales.length === 0) {
      throw new ConvexError('crearEntradasBatch: se necesita al menos un material.');
    }
    const params = await ctx.db.query('parametrosProduccion').first();
    if (!params) {
      throw new Error('crearEntradasBatch: no hay parámetros de producción configurados.');
    }
    // EDS-83: a diferencia de un cierre de turno, SÍ es normal registrar
    // tarde el papeleo de una entrada real vieja — solo se valida formato
    // y que no sea futura, sin límite hacia atrás (diasAtras: null).
    validarFechaOperativaEnVentana(args.fecha, params.zonaHoraria, params.horaInicioTurno1, null);
    const ids: Id<'entradas'>[] = [];
    for (const m of args.materiales) {
      const id = await crearEntradaImpl(ctx, user, { fecha: args.fecha, materialId: m.materialId, cantidadKg: m.cantidadKg });
      ids.push(id);
    }
    return ids;
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
      throw new ConvexError('costearEntrada: costoUnitario no puede ser negativo.');
    }

    const entrada = await ctx.db.get(args.entradaId);
    if (!entrada) {
      throw new ConvexError('costearEntrada: la entrada no existe.');
    }
    if (entrada.estado === 'costeada') {
      throw new ConvexError(
        'Esta entrada ya fue costeada — para corregir su costo/cantidad usa Corrección de Capturas, no vuelvas a costearla.'
      );
    }

    // Defensa adicional: el material pudo haberse desactivado entre que se
    // creó la entrada (pendiente) y el momento de costearla.
    await validarMaterialParaEntrada(ctx, entrada.materialId);

    const capaId = await crearCapaImpl(ctx, {
      materialId: entrada.materialId,
      kgOriginal: entrada.cantidadKg,
      costoUnitario: args.costoUnitario,
      fechaEntrada: fechaStringATimestamp(entrada.fecha),
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

// Devuelve costo unitario y valor de capas — dato financiero, restringido a
// Compras/Admin (igual que el guard de página de entradas-costeo.html).
export const listEntradas = query({
  args: { desde: v.optional(v.string()), hasta: v.optional(v.string()), token: v.string() },
  handler: async (ctx, { desde, hasta, token }) => {
    await requireRole(ctx, token, ['compras', 'admin']);
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
    await requireRole(ctx, token, ['compras', 'admin']);
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

// Lista liviana para poblar el selector de material — no incluye Triturado
// (no se "compra", se genera internamente por merma) ni los campos
// calculados de Catálogo (%mezcla, reorden), que son de la Épica 2. Sin
// datos de costo, así que se deja disponible a cualquier rol autenticado
// (la usan tanto entradas-costeo.html —compras/admin— como, más adelante,
// el flujo de "Entrada de material" del operador en cierre-turno).
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
      throw new ConvexError('eliminarEntradaPendiente: la entrada no existe.');
    }
    if (entrada.estado !== 'pendiente' || entrada.capaId !== null) {
      throw new ConvexError(
        'Solo se pueden eliminar entradas pendientes sin costear. Una entrada ya costeada se corrige desde Corrección de Capturas.'
      );
    }
    await ctx.db.delete(entradaId);
    return { ok: true };
  },
});
