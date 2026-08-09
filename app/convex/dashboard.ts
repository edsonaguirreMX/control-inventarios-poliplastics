import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { QueryCtx } from './_generated/server';
import { requireRole } from './lib/auth';
import { fechaOperativa, sumarDiasISO } from './lib/fechaOperativa';

// Roles que ven Panel de Control (mismo criterio que el guard de la
// página en panel-control.html) — operador no tiene esta pantalla, su
// captura vive en Cierre de Turno.
// Exportado: reporteDiario.ts lo reutiliza como destinatarios de la
// notificación in-app "reporte generado" — son los mismos roles que
// pueden ver Panel de Control, así no hace falta un selector de roles
// aparte en reporteDiarioConfig ni arriesgar que diverja de quién
// realmente consume el dashboard.
export const ROLES_DASHBOARD = ['compras', 'calidad', 'gerencia', 'admin'] as const;

// Ventana para "consumo diario promedio" — alimenta el punto de reorden
// (regla 4 del spec: consumo diario promedio × (lead time + stock de
// seguridad en días, default 7)). 14 días es suficiente para amortiguar
// variación turno a turno sin diluir una tendencia reciente real.
const VENTANA_CONSUMO_DIAS = 14;

export async function requireParametros(ctx: QueryCtx) {
  const params = await ctx.db.query('parametrosProduccion').first();
  if (!params) {
    throw new Error('Panel de Control: no hay parámetros de producción configurados (parametrosProduccion vacío).');
  }
  return params;
}

export async function fechaHoyOperativa(ctx: QueryCtx): Promise<{ hoy: string; kgPorMetro: number }> {
  const params = await requireParametros(ctx);
  return { hoy: fechaOperativa(Date.now(), params.zonaHoraria, params.horaInicioTurno1), kgPorMetro: params.kgPorMetro };
}

// Cierres cuyo campo `fecha` cae en los últimos `dias` días operativos
// (incluyendo hoy), vía el índice by_fecha — una sola query con rango,
// no N queries por día. Cada doc de cierresTurno ya refleja su estado
// ACTUAL (aplicarCierreImpl/recapturarCierreImpl lo sobreescriben en el
// mismo lugar): no hace falta filtrar "vigente" aquí, eso solo aplica a
// cierreConsumos (que sí conserva filas viejas para auditoría).
export async function cierresEnRango(ctx: QueryCtx, dias: number) {
  const { hoy } = await fechaHoyOperativa(ctx);
  const diaInicio = sumarDiasISO(hoy, -(dias - 1));
  const fechas = Array.from({ length: dias }, (_, i) => sumarDiasISO(diaInicio, i));
  const cierres = await ctx.db
    .query('cierresTurno')
    .withIndex('by_fecha', (q) => q.gte('fecha', diaInicio).lte('fecha', hoy))
    .collect();
  return { hoy, fechas, cierres };
}

// KPIs "de hoy" + desglose por material — extraído a función plana (sin
// requireRole) para que el motor de alertas (7.2, alertas.ts) pueda
// reutilizar EXACTAMENTE el mismo cálculo de existencia/reorden/merma/costo
// que ve Compras/Calidad/Gerencia en el Panel de Control, en vez de
// reimplementarlo por separado (eso sí divergiría con el tiempo — mismo
// riesgo ya resuelto para Catálogo/Parámetros en PR 5). `getKPIsHoy` (más
// abajo) es un wrapper delgado que solo agrega la autorización.
export async function calcularKPIsHoyImpl(ctx: QueryCtx) {
    const params = await requireParametros(ctx);
    const { hoy, cierres: cierresVentana } = await cierresEnRango(ctx, VENTANA_CONSUMO_DIAS);

    const materiales = await ctx.db.query('materiales').withIndex('by_activo_orden', (q) => q.eq('activo', true)).collect();

    // Existencia y valor por material — derivado de capasCosto no
    // agotadas (misma fuente que peps.existenciaMaterial/
    // valorInventarioMaterial; aquí en bulk para no hacer 2×8 queries
    // individuales en cada carga del dashboard).
    const capasVigentes = await ctx.db.query('capasCosto').filter((q) => q.eq(q.field('agotada'), false)).collect();
    const existenciaPorMaterial = new Map<string, number>();
    const valorPorMaterial = new Map<string, number>();
    for (const c of capasVigentes) {
      existenciaPorMaterial.set(c.materialId, (existenciaPorMaterial.get(c.materialId) ?? 0) + c.kgRestante);
      valorPorMaterial.set(c.materialId, (valorPorMaterial.get(c.materialId) ?? 0) + c.kgRestante * c.costoUnitario);
    }

    // Consumo diario promedio por material — SOLO cierreConsumos con
    // vigente:true; un recierre o corrección marca las filas viejas
    // vigente:false pero las conserva para auditoría, y NUNCA deben
    // contarse aquí (bloqueante recurrente en las auditorías del
    // proyecto: "el dashboard calcula con datos obsoletos").
    const consumoTotalPorMaterial = new Map<string, number>();
    for (const cierre of cierresVentana) {
      const consumos = await ctx.db
        .query('cierreConsumos')
        .withIndex('by_cierreTurnoId_vigente', (q) => q.eq('cierreTurnoId', cierre._id).eq('vigente', true))
        .collect();
      for (const c of consumos) {
        consumoTotalPorMaterial.set(c.materialId, (consumoTotalPorMaterial.get(c.materialId) ?? 0) + c.kgConsumido);
      }
    }

    // Punto de reorden (regla 4 del spec, no negociable):
    // consumo diario promedio × (lead time + stock de seguridad en días,
    // default 7 si no está configurado). Triturado (esInterno, se genera
    // internamente) y HDPE virgen (esSustituto, sin cupo de consumo fijo)
    // no tienen punto de reorden — igual que en el mockup original.
    const materialesConDetalle = materiales.map((m) => {
      const existenciaKg = existenciaPorMaterial.get(m._id) ?? 0;
      const valorKg = valorPorMaterial.get(m._id) ?? 0;
      const sinReorden = m.esInterno || m.esSustituto;
      if (sinReorden) {
        return {
          materialId: m._id, nombre: m.nombre, variante: m.variante,
          esInterno: m.esInterno, esSustituto: m.esSustituto,
          existenciaKg, valorKg, cantidadPedirKg: m.cantidadPedirKg,
          reorderKg: null, coberturaDias: null, status: 'neutral' as const,
        };
      }
      const consumoTotal = consumoTotalPorMaterial.get(m._id) ?? 0;
      const consumoDiarioPromedio = consumoTotal / VENTANA_CONSUMO_DIAS;
      const stockSeguridad = m.stockSeguridadDias ?? 7;
      const leadTime = m.leadTimeDias ?? 0;
      const reorderCalculado = consumoDiarioPromedio * (leadTime + stockSeguridad);
      const reorderKg = m.reorderMode === 'manual' && m.reorderManualKg !== null ? m.reorderManualKg : reorderCalculado;
      const coberturaDias = consumoDiarioPromedio > 0 ? existenciaKg / consumoDiarioPromedio : null;
      const status: 'crit' | 'warn' | 'ok' =
        existenciaKg < reorderKg ? 'crit' : existenciaKg < reorderKg * 1.15 ? 'warn' : 'ok';
      return {
        materialId: m._id, nombre: m.nombre, variante: m.variante,
        esInterno: m.esInterno, esSustituto: m.esSustituto,
        existenciaKg, valorKg, cantidadPedirKg: m.cantidadPedirKg,
        reorderKg, coberturaDias, status,
      };
    });

    const valorInventarioTotal = materialesConDetalle.reduce((s, m) => s + m.valorKg, 0);

    const cierresHoy = cierresVentana.filter((c) => c.fecha === hoy);
    const kgBuenosHoy = cierresHoy.reduce((s, c) => s + c.kgBuenos, 0);
    const metrosBuenosHoy = cierresHoy.reduce((s, c) => s + c.metrosBuenos, 0);
    const mermaTotalHoy = cierresHoy.reduce((s, c) => s + c.mermaTotalKg, 0);
    const costoTotalHoy = cierresHoy.reduce((s, c) => s + c.costoTotalConsumido, 0);
    const totalProcesadoHoy = kgBuenosHoy + mermaTotalHoy;
    const pctMermaHoy = totalProcesadoHoy > 0 ? (mermaTotalHoy / totalProcesadoHoy) * 100 : 0;
    const costoRealPorKgHoy = kgBuenosHoy > 0 ? costoTotalHoy / kgBuenosHoy : 0;
    const costoRealPorMetroHoy = metrosBuenosHoy > 0 ? costoTotalHoy / metrosBuenosHoy : 0;

    // Costo estándar de referencia: Σ %fórmula × costoEstandar de catálogo
    // (mismo cálculo que el mockup original, ahora con datos reales).
    const formula = await ctx.db.query('formulaCarga').collect();
    const totalKgPorCarga = formula.reduce((s, f) => s + f.kgPorCarga, 0);
    const materialesPorId = new Map(materiales.map((m) => [m._id, m]));
    const costoEstandarPorKg =
      totalKgPorCarga > 0
        ? formula.reduce((s, f) => {
            const mat = materialesPorId.get(f.materialId);
            return mat ? s + (f.kgPorCarga / totalKgPorCarga) * mat.costoEstandar : s;
          }, 0)
        : 0;
    const costoEstandarPorMetro = costoEstandarPorKg * params.kgPorMetro;

    return {
      fecha: hoy,
      materiales: materialesConDetalle,
      valorInventarioTotal,
      pctMermaHoy,
      produccionHoyKg: kgBuenosHoy,
      produccionHoyMetros: metrosBuenosHoy,
      costoRealHoy: costoTotalHoy,
      costoRealPorKgHoy,
      costoRealPorMetroHoy,
      costoEstandarPorKg,
      costoEstandarPorMetro,
    };
}

export const getKPIsHoy = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireRole(ctx, token, ROLES_DASHBOARD);
    return calcularKPIsHoyImpl(ctx);
  },
});

export const produccionPorRango = query({
  args: { dias: v.number(), token: v.string() },
  handler: async (ctx, { dias, token }) => {
    await requireRole(ctx, token, ROLES_DASHBOARD);
    if (dias <= 0) throw new Error('produccionPorRango: dias debe ser mayor a 0.');
    const { fechas, cierres } = await cierresEnRango(ctx, dias);
    return fechas.map((fecha) => {
      const delDia = cierres.filter((c) => c.fecha === fecha);
      const metros = (linea: 1 | 2, turno: 1 | 2) => delDia.find((c) => c.linea === linea && c.turno === turno)?.metrosBuenos ?? 0;
      return {
        fecha,
        linea1Turno1: metros(1, 1), linea1Turno2: metros(1, 2),
        linea2Turno1: metros(2, 1), linea2Turno2: metros(2, 2),
      };
    });
  },
});

export const tendenciaMerma = query({
  args: { dias: v.number(), token: v.string() },
  handler: async (ctx, { dias, token }) => {
    await requireRole(ctx, token, ROLES_DASHBOARD);
    if (dias <= 0) throw new Error('tendenciaMerma: dias debe ser mayor a 0.');
    const { fechas, cierres } = await cierresEnRango(ctx, dias);
    return fechas.map((fecha) => {
      const delDia = cierres.filter((c) => c.fecha === fecha);
      const kgBuenos = delDia.reduce((s, c) => s + c.kgBuenos, 0);
      const merma = delDia.reduce((s, c) => s + c.mermaTotalKg, 0);
      const total = kgBuenos + merma;
      return { fecha, pctMerma: total > 0 ? (merma / total) * 100 : 0 };
    });
  },
});

export const tendenciaCosto = query({
  args: { dias: v.number(), token: v.string() },
  handler: async (ctx, { dias, token }) => {
    await requireRole(ctx, token, ROLES_DASHBOARD);
    if (dias <= 0) throw new Error('tendenciaCosto: dias debe ser mayor a 0.');
    const { fechas, cierres } = await cierresEnRango(ctx, dias);
    return fechas.map((fecha) => {
      const delDia = cierres.filter((c) => c.fecha === fecha);
      const kgBuenos = delDia.reduce((s, c) => s + c.kgBuenos, 0);
      const costo = delDia.reduce((s, c) => s + c.costoTotalConsumido, 0);
      return { fecha, costoRealPorKg: kgBuenos > 0 ? costo / kgBuenos : 0 };
    });
  },
});

// Metas de producción (tarea 6.5) — singleton, igual patrón que
// parametrosProduccion. Lectura: cualquier rol del dashboard. Escritura:
// solo admin (el spec de roles no le da a Calidad ni Gerencia edición de
// metas, solo lectura del dashboard de desviación/costos).
export const getObjetivos = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireRole(ctx, token, ROLES_DASHBOARD);
    const obj = await ctx.db.query('objetivosProduccion').first();
    return obj ?? { turnoL1: 0, turnoL2: 0, semana: 0, mes: 0 };
  },
});

export const updateObjetivos = mutation({
  args: {
    turnoL1: v.number(), turnoL2: v.number(), semana: v.number(), mes: v.number(),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.token, ['admin']);
    if (args.turnoL1 < 0 || args.turnoL2 < 0 || args.semana < 0 || args.mes < 0) {
      throw new Error('updateObjetivos: las metas no pueden ser negativas.');
    }
    const existente = await ctx.db.query('objetivosProduccion').first();
    const now = Date.now();
    const datos = { turnoL1: args.turnoL1, turnoL2: args.turnoL2, semana: args.semana, mes: args.mes, updatedAt: now };
    if (existente) {
      await ctx.db.patch(existente._id, datos);
    } else {
      await ctx.db.insert('objetivosProduccion', datos);
    }
    return { ok: true };
  },
});
