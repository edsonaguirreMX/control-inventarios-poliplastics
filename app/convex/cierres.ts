import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireRole } from './lib/auth';
import { aplicarCierreImpl, recapturarCierreImpl } from './cierreEngine';

const LINEAS = [1, 2] as const;
const TURNOS = [1, 2] as const;

// Estado de las 4 combinaciones línea×turno de un día — el operador ve de
// un vistazo cuáles ya se cerraron. No es una tabla, se deriva del índice
// by_fecha_linea_turno de cierresTurno.
export const estadoCierresDelDia = query({
  args: { fecha: v.string(), token: v.string() },
  handler: async (ctx, { fecha, token }) => {
    await requireRole(ctx, token, ['operador', 'admin']);
    const resultado = [];
    for (const linea of LINEAS) {
      for (const turno of TURNOS) {
        const cierre = await ctx.db
          .query('cierresTurno')
          .withIndex('by_fecha_linea_turno', (q) => q.eq('fecha', fecha).eq('linea', linea).eq('turno', turno))
          .unique();
        resultado.push({
          linea,
          turno,
          cerrado: cierre !== null,
          cierreTurnoId: cierre?._id ?? null,
          editado: cierre?.editado ?? false,
          vecesRecapturado: cierre?.vecesRecapturado ?? 0,
        });
      }
    }
    return resultado;
  },
});

// kg esperados por material según la fórmula por carga × cargas
// preparadas — la MISMA fórmula que alimenta el % de mezcla en Catálogo
// (Épica 2), fuente única de verdad. La fórmula es una sola para ambas
// líneas (Lambrín/Thermo-PVC están fuera de alcance), así que no depende
// de línea/turno — solo de cuántas cargas se prepararon.
export const consumoEsperado = query({
  args: { cargasPreparadas: v.number(), token: v.string() },
  handler: async (ctx, { cargasPreparadas, token }) => {
    await requireRole(ctx, token, ['operador', 'admin']);
    const formula = await ctx.db.query('formulaCarga').collect();
    const materiales = await ctx.db.query('materiales').withIndex('by_activo_orden', (q) => q.eq('activo', true)).collect();
    const nombrePorId = new Map(materiales.map((m) => [m._id, m]));
    return formula
      .map((f) => {
        const material = nombrePorId.get(f.materialId);
        return {
          materialId: f.materialId,
          nombre: material?.nombre ?? '?',
          variante: material?.variante ?? '',
          kgPorCarga: f.kgPorCarga,
          kgEsperado: f.kgPorCarga * cargasPreparadas,
          esSustituto: material?.esSustituto ?? false,
          esInterno: material?.esInterno ?? false,
        };
      })
      .filter((f) => nombrePorId.has(f.materialId)); // ignora materiales desactivados
  },
});

export const crearCierreTurno = mutation({
  args: {
    fecha: v.string(),
    linea: v.union(v.literal(1), v.literal(2)),
    turno: v.union(v.literal(1), v.literal(2)),
    cargasPreparadas: v.number(),
    metrosBuenos: v.number(),
    caballetes105Pzas: v.number(),
    caballetes106Pzas: v.number(),
    consumoPorMaterial: v.array(v.object({ materialId: v.id('materiales'), kgConsumido: v.number() })),
    confirmarRecierre: v.optional(v.boolean()),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireRole(ctx, args.token, ['operador', 'admin']);

    if (args.cargasPreparadas < 0) {
      throw new Error('crearCierreTurno: cargasPreparadas no puede ser negativo.');
    }

    const existente = await ctx.db
      .query('cierresTurno')
      .withIndex('by_fecha_linea_turno', (q) => q.eq('fecha', args.fecha).eq('linea', args.linea).eq('turno', args.turno))
      .unique();

    if (!existente) {
      const now = Date.now();
      const cierreTurnoId = await ctx.db.insert('cierresTurno', {
        fecha: args.fecha,
        linea: args.linea,
        turno: args.turno,
        cargasPreparadas: args.cargasPreparadas,
        metrosBuenos: args.metrosBuenos,
        caballetes105Pzas: args.caballetes105Pzas,
        caballetes106Pzas: args.caballetes106Pzas,
        // Totales en 0 — aplicarCierreImpl los calcula y el patch de abajo
        // los reemplaza; aplicarCierreImpl NUNCA escribe este doc.
        kgBuenos: 0,
        caballetesKg: 0,
        mermaTotalKg: 0,
        trituradoKg: 0,
        costoTotalConsumido: 0,
        costoRealPorKg: 0,
        costoRealPorMetro: 0,
        capturadoPor: user._id,
        capturadoEn: now,
        editado: false,
        editadoPor: null,
        editadoEn: null,
        vecesRecapturado: 0,
      });

      const totales = await aplicarCierreImpl(ctx, {
        cierreTurnoId,
        metrosBuenos: args.metrosBuenos,
        caballetes105Pzas: args.caballetes105Pzas,
        caballetes106Pzas: args.caballetes106Pzas,
        consumoPorMaterial: args.consumoPorMaterial,
        createdBy: user._id,
      });
      await ctx.db.patch(cierreTurnoId, totales);

      return { yaExistia: false, cierreTurnoId };
    }

    if (!args.confirmarRecierre) {
      // Solo informa — no escribe nada. La UI decide si muestra la
      // advertencia y vuelve a llamar con confirmarRecierre:true.
      return { yaExistia: true, cierreTurnoId: existente._id };
    }

    // Recierre: nunca se inserta un segundo documento ni se vuelve a
    // consumir PEPS sin antes revertir el consumo anterior — evita el
    // doble descuento de inventario. recapturarCierreImpl hace
    // revertir→aplicar→patch→auditoría en un solo lugar (mismo camino que
    // usa 5.2 para correcciones administrativas).
    await recapturarCierreImpl(ctx, {
      cierreTurnoId: existente._id,
      cargasPreparadas: args.cargasPreparadas,
      metrosBuenos: args.metrosBuenos,
      caballetes105Pzas: args.caballetes105Pzas,
      caballetes106Pzas: args.caballetes106Pzas,
      consumoPorMaterial: args.consumoPorMaterial,
      motivo: 'recierre_duplicado',
      nota: null,
      createdBy: user._id,
    });

    return { yaExistia: true, recierreAplicado: true, cierreTurnoId: existente._id };
  },
});
