import { v, ConvexError } from 'convex/values';
import { mutation, query } from './_generated/server';
import type { QueryCtx } from './_generated/server';
import { requireRole, requireAcceso } from './lib/auth';
import { fechaOperativa, sumarDiasISO } from './lib/fechaOperativa';
import { consumoDiarioTeorico, puntoReordenTeorico } from './lib/puntoReorden';

// EDS-105: este arreglo YA NO gatea el acceso a las queries del
// dashboard — esas migraron a requireAcceso(ctx, token, 'panel-control'),
// que resuelve contra la tabla dinámica `roles`. ROLES_DASHBOARD se queda
// exportado únicamente como DATO: reporteDiario.ts lo reutiliza como lista
// fija de destinatarios de la notificación in-app "reporte generado". Es
// un snapshot de los roles base de hoy, no una fuente de verdad dinámica
// — un rol nuevo creado desde Gestión de Roles con acceso a
// panel-control SÍ podrá ver el dashboard, pero NO aparecerá aquí como
// destinatario de esa notificación hasta que alguien actualice esta lista
// a mano (deuda conocida, fuera de alcance de EDS-105 — el alcance de esta
// épica es acceso a pantallas, no la lista de destinatarios de
// notificaciones).
export const ROLES_DASHBOARD = ['compras', 'calidad', 'gerencia', 'admin'] as const;

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

    // EDS-88: punto de reorden UNIFICADO con Catálogo de Materiales — antes
    // este dashboard promediaba el consumo REAL de los últimos 14 días
    // (cierreConsumos vigentes) y Catálogo usaba el consumo TEÓRICO de
    // fórmula; a pedido explícito del usuario, Catálogo es ahora la única
    // fuente de verdad y este cálculo es un espejo exacto (misma función
    // compartida lib/puntoReorden.ts, mismos parámetros
    // cargasPorTurno/turnosPorDia/lineasActivas editables desde Catálogo).
    // Consecuencia aceptada: las alertas material-critico/material-por-vencer
    // (que reutilizan esta función) también pasan a evaluarse contra el
    // punto de reorden teórico, no el histórico real.
    const formula = await ctx.db.query('formulaCarga').collect();
    const formulaPorMaterial = new Map(formula.map((f) => [f.materialId, f]));
    const paramsConsumo = { cargasPorTurno: params.cargasPorTurno, turnosPorDia: params.turnosPorDia, lineasActivas: params.lineasActivas ?? 2 };

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
      const kgPorCarga = formulaPorMaterial.get(m._id)?.kgPorCarga ?? 0;
      const consumoDiario = consumoDiarioTeorico(kgPorCarga, paramsConsumo);
      const reorderCalculado = puntoReordenTeorico(consumoDiario, m.leadTimeDias, m.stockSeguridadDias);
      const reorderKg = m.reorderMode === 'manual' && m.reorderManualKg !== null ? m.reorderManualKg : reorderCalculado;
      const coberturaDias = consumoDiario > 0 ? existenciaKg / consumoDiario : null;
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

    // EDS-90: "hoy" nunca tiene cierres capturados el mismo día — en la
    // operación real, un turno se cierra horas o días después de que
    // terminó. Las tarjetas de producción/merma/costo "de hoy" quedaban
    // en 0 casi todo el tiempo porque agregaban cierresTurno de la fecha
    // operativa de HOY. Se usa la fecha del ÚLTIMO cierre capturado como
    // referencia (mismo obtenerUltimoCierreImpl que ya usa el topbar,
    // EDS-75) — mismo criterio de agregación de siempre (todas las
    // combinaciones línea×turno de esa fecha), solo cambia qué fecha se
    // usa. Consecuencia aceptada explícitamente por el usuario: las
    // alertas merma-alta/costo-alto (alertas.ts, reutilizan esta función)
    // también evalúan ahora contra el último cierre real en vez de "hoy"
    // (que casi nunca tenía datos con los que disparar).
    const ultimoCierre = await obtenerUltimoCierreImpl(ctx);
    const cierresReferencia = ultimoCierre
      ? await ctx.db.query('cierresTurno').withIndex('by_fecha', (q) => q.eq('fecha', ultimoCierre.fecha)).collect()
      : [];

    const kgBuenosUltimoCierre = cierresReferencia.reduce((s, c) => s + c.kgBuenos, 0);
    const metrosBuenosUltimoCierre = cierresReferencia.reduce((s, c) => s + c.metrosBuenos, 0);
    const mermaTotalUltimoCierre = cierresReferencia.reduce((s, c) => s + c.mermaTotalKg, 0);
    const costoTotalUltimoCierre = cierresReferencia.reduce((s, c) => s + c.costoTotalConsumido, 0);
    const totalProcesadoUltimoCierre = kgBuenosUltimoCierre + mermaTotalUltimoCierre;
    const pctMermaUltimoCierre = totalProcesadoUltimoCierre > 0 ? (mermaTotalUltimoCierre / totalProcesadoUltimoCierre) * 100 : 0;
    const costoRealPorKgUltimoCierre = kgBuenosUltimoCierre > 0 ? costoTotalUltimoCierre / kgBuenosUltimoCierre : 0;
    const costoRealPorMetroUltimoCierre = metrosBuenosUltimoCierre > 0 ? costoTotalUltimoCierre / metrosBuenosUltimoCierre : 0;

    // Costo estándar de referencia: Σ %fórmula × costoEstandar de catálogo
    // (mismo cálculo que el mockup original, ahora con datos reales).
    // Reutiliza `formula` ya cargada arriba para el punto de reorden.
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
      fecha: ultimoCierre?.fecha ?? fechaOperativa(Date.now(), params.zonaHoraria, params.horaInicioTurno1),
      materiales: materialesConDetalle,
      valorInventarioTotal,
      pctMermaUltimoCierre,
      produccionUltimoCierreKg: kgBuenosUltimoCierre,
      produccionUltimoCierreMetros: metrosBuenosUltimoCierre,
      costoUltimoCierre: costoTotalUltimoCierre,
      costoRealPorKgUltimoCierre,
      costoRealPorMetroUltimoCierre,
      costoEstandarPorKg,
      costoEstandarPorMetro,
    };
}

// EDS-75: la línea "Actualizado con el cierre de Turno X · fecha" del
// topbar era texto estático desde el mockup original — nunca reflejó un
// cierre real, ni siquiera vacío. Se resuelve buscando el cierresTurno
// más recientemente insertado — no por `fecha` sola (empata entre
// línea/turno del mismo día) ni acotado a la ventana de `cierresEnRango`
// (un cierre real puede ser más viejo que esos 14 días si la planta
// llevó varios días sin capturar). Se ordena por `_creationTime` (lo da
// Convex, único y monótono por documento) y no por el campo de negocio
// `capturadoEn` (`Date.now()` de la app — dos mutations seguidas pueden
// empatar al milisegundo, sobre todo en pruebas).
//
// Hallazgo de CodeRabbit en la revisión de PR EDS-75: la primera versión
// hacía `.collect()` de toda la tabla y reducía a mano — un table scan
// completo en cada carga del Panel de Control. `cierresTurno` no tiene
// política de borrado (convención "nada se borra" del proyecto), así que
// crece indefinidamente; el índice `by_creation_time` que Convex ya trae
// por default resuelve exactamente "el documento más reciente" con
// `.order('desc')`, sin escanear nada.
//
// EDS-101 — pedido explícito del usuario, encontrado en validación de
// producción tras EDS-100: en producción se capturó un cierre real para
// un domingo con TODAS las líneas/turnos en 0 (día no laborado, mismo
// escenario de EDS-100), y ese cierre quedó siendo "el último" — todos
// los KPIs y el Reporte Directivo (EDS-99, que lee estos mismos campos)
// mostraban 0 y la fecha del domingo en vez de los datos reales del
// último día que sí trabajó. Ya no basta `.first()`: se recorre hacia
// atrás un LOTE ACOTADO de cierres recientes (mismo criterio de "sin
// table scan" de arriba) y, para cada FECHA distinta encontrada, se
// revisa el total de ESA fecha completa (todas sus líneas/turnos vía
// by_fecha — mismo patrón que calcularKPIsHoyImpl usa para
// cierresReferencia) hasta hallar una con actividad real. Mismo criterio
// de "actividad real" que EDS-100 (kgBuenos + mermaTotalKg > 0 — no
// depende del costo, un día solo con Triturado a $0 sí cuenta).
//
// Nota sobre CAPTURA vs. FECHA (hallazgo de CodeRabbit en la revisión de
// este PR): con 2 fechas CON actividad real capturadas fuera de orden
// cronológico, esta función puede devolver la fecha calendario más VIEJA
// en vez de la más nueva — es intencional, no un bug. "Último cierre"
// siempre significó "lo último que el operador confirmó" (ver el bloque
// de EDS-75 arriba y su test "no el de fecha más reciente"), nunca "el
// día calendario más reciente"; EDS-101 solo le agrega "salvo que esa
// captura sea un día sin actividad real". Cambiar esto a ordenar por
// fecha calendario rompería ese contrato ya probado desde EDS-75. Test de
// regresión que deja esto explícito con 2 fechas reales de por medio (no
// solo una real y una en cero): "con 2 fechas con actividad capturadas
// fuera de orden, gana la CAPTURADA más recientemente".
const LOOKBACK_CIERRES_ULTIMO = 60; // ~15 días asumiendo hasta 4 cierres/día (2 líneas × 2 turnos) — cota generosa para saltar un domingo/festivo aislado sin escanear toda la tabla.

export async function obtenerUltimoCierreImpl(ctx: QueryCtx) {
  const recientes = await ctx.db.query('cierresTurno').order('desc').take(LOOKBACK_CIERRES_ULTIMO);
  if (recientes.length === 0) return null;

  const fechasEvaluadas = new Set<string>();
  for (const candidato of recientes) {
    if (fechasEvaluadas.has(candidato.fecha)) continue;
    fechasEvaluadas.add(candidato.fecha);
    const cierresDeLaFecha = await ctx.db.query('cierresTurno').withIndex('by_fecha', (q) => q.eq('fecha', candidato.fecha)).collect();
    const huboActividad = cierresDeLaFecha.some((c) => c.kgBuenos + c.mermaTotalKg > 0);
    if (huboActividad) {
      return { fecha: candidato.fecha, linea: candidato.linea, turno: candidato.turno };
    }
  }
  // Si TODO el lote está en cero (caso extremo — varias semanas seguidas
  // sin actividad), mejor mostrar el cierre más reciente capturado
  // (aunque sea 0) que no mostrar nada.
  const masReciente = recientes[0];
  return { fecha: masReciente.fecha, linea: masReciente.linea, turno: masReciente.turno };
}

export const getKPIsHoy = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAcceso(ctx, token, 'panel-control');
    const [kpis, ultimoCierre] = await Promise.all([
      calcularKPIsHoyImpl(ctx),
      obtenerUltimoCierreImpl(ctx),
    ]);
    return { ...kpis, ultimoCierre };
  },
});

// EDS-98 — hardening: las 4 queries de esta familia ("dame X sobre los
// últimos `dias`") comparten el mismo riesgo que ya encontró CodeRabbit
// (Major) en kpisPorRango (PR EDS-97): un `dias` sin cota superior ni
// chequeo de entero llega directo a cierresEnRango, que hace
// `Array.from({length: dias}, ...)` — un valor fraccionario o
// absurdamente grande intenta reservar un arreglo de ese tamaño antes de
// procesar nada (abuso/DoS trivial). kpisPorRango ya se corrigió
// restringiendo a exactamente [7, 14, 30] — únicos valores que su selector
// de UI ofrece. produccionPorRango/tendenciaMerma/tendenciaCosto se
// llaman hoy siempre con `dias:30` (panel-control.html las trae una sola
// vez en cargarTodo() y el selector "Tendencias 7/14/30 días" solo
// recorta ese arreglo ya cargado en el cliente, sin volver a llamar al
// servidor) — pero por eso mismo se les aplica el mismo conjunto [7,14,30]
// que kpisPorRango, no solo {30}: son la misma familia de queries de
// rango del dashboard y ya hay precedente histórico de un selector en
// pantalla pidiendo 7/14 directo al servidor: restringir a un conjunto más
// angosto que el resto de la familia sería una trampa a futuro si ese
// patrón vuelve.
const DIAS_RANGO_VALIDOS = [7, 14, 30] as const;

function validarDiasRango(nombreFuncion: string, dias: number) {
  if (!DIAS_RANGO_VALIDOS.includes(dias as (typeof DIAS_RANGO_VALIDOS)[number])) {
    throw new ConvexError(`${nombreFuncion}: dias debe ser uno de ${DIAS_RANGO_VALIDOS.join(', ')}.`);
  }
}

// EDS-113 — extraído a *Impl para reutilizarse server-side (PDF adjunto de
// Reporte Diario, ver reportePdf.ts) sin requerir un token de sesión de
// usuario, que una internalAction de cron no tiene. Mismo patrón *Impl +
// wrapper delgado que el resto del archivo (calcularKPIsHoyImpl arriba).
export async function produccionPorRangoImpl(ctx: QueryCtx, dias: number) {
  validarDiasRango('produccionPorRango', dias);
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
}

export const produccionPorRango = query({
  args: { dias: v.number(), token: v.string() },
  handler: async (ctx, { dias, token }) => {
    await requireAcceso(ctx, token, 'panel-control');
    return produccionPorRangoImpl(ctx, dias);
  },
});

export const tendenciaMerma = query({
  args: { dias: v.number(), token: v.string() },
  handler: async (ctx, { dias, token }) => {
    await requireAcceso(ctx, token, 'panel-control');
    validarDiasRango('tendenciaMerma', dias);
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

export async function tendenciaCostoImpl(ctx: QueryCtx, dias: number) {
  validarDiasRango('tendenciaCosto', dias);
  const { fechas, cierres } = await cierresEnRango(ctx, dias);
  return fechas.map((fecha) => {
    const delDia = cierres.filter((c) => c.fecha === fecha);
    const kgBuenos = delDia.reduce((s, c) => s + c.kgBuenos, 0);
    const costo = delDia.reduce((s, c) => s + c.costoTotalConsumido, 0);
    return { fecha, costoRealPorKg: kgBuenos > 0 ? costo / kgBuenos : 0 };
  });
}

export const tendenciaCosto = query({
  args: { dias: v.number(), token: v.string() },
  handler: async (ctx, { dias, token }) => {
    await requireAcceso(ctx, token, 'panel-control');
    return tendenciaCostoImpl(ctx, dias);
  },
});

// EDS-97 — pedido explícito del usuario: las tarjetas de % merma/
// producción (Calidad) y costo real/kg/metro (Gerencia) solo mostraban el
// último cierre; ahora se puede elegir un periodo (última semana, últimos
// 14/30 días) además de "último cierre". Mismo cálculo agregado que ya usa
// calcularKPIsHoyImpl para su bloque "último cierre" (Σmerma/Σtotal,
// Σcosto/Σkg — nunca un promedio de porcentajes diarios, que subestimaría
// días de alta producción), pero sobre `cierresEnRango(ctx, dias)` en vez
// de solo los cierres de la fecha del último cierre.
export async function kpisPorRangoImpl(ctx: QueryCtx, dias: number) {
  validarDiasRango('kpisPorRango', dias);
  const params = await requireParametros(ctx);
  const { fechas, cierres } = await cierresEnRango(ctx, dias);

  const kgBuenos = cierres.reduce((s, c) => s + c.kgBuenos, 0);
  const metrosBuenos = cierres.reduce((s, c) => s + c.metrosBuenos, 0);
  const mermaTotalKg = cierres.reduce((s, c) => s + c.mermaTotalKg, 0);
  const costoTotal = cierres.reduce((s, c) => s + c.costoTotalConsumido, 0);
  const totalProcesado = kgBuenos + mermaTotalKg;
  const pctMerma = totalProcesado > 0 ? (mermaTotalKg / totalProcesado) * 100 : 0;
  const costoRealPorKg = kgBuenos > 0 ? costoTotal / kgBuenos : 0;
  const costoRealPorMetro = costoRealPorKg * params.kgPorMetro;

  return {
    dias,
    fechaDesde: fechas[0],
    fechaHasta: fechas[fechas.length - 1],
    pctMerma,
    produccionKg: kgBuenos,
    produccionMetros: metrosBuenos,
    costoTotal,
    costoRealPorKg,
    costoRealPorMetro,
  };
}

export const kpisPorRango = query({
  args: { dias: v.number(), token: v.string() },
  handler: async (ctx, { dias, token }) => {
    await requireAcceso(ctx, token, 'panel-control');
    return kpisPorRangoImpl(ctx, dias);
  },
});

// EDS-99 — Reporte Directivo: "costo real por kg / por metro" promedio de
// los últimos N *cierres* (no días naturales), a pedido explícito del
// usuario. Con la planta operando 2 líneas y hasta 2 turnos, un promedio
// por día natural queda diluido por días sin captura (quedan en 0); los
// últimos N cierres reales reflejan el costo reciente sin importar en
// cuántos días naturales cayeron. Mismo criterio de "más reciente" que
// obtenerUltimoCierreImpl (order('desc'), por _creationTime — no por el
// campo `fecha`, que empata entre línea/turno del mismo día).
// Cota superior defensiva (mismo criterio que kpisPorRango tras el
// hallazgo de CodeRabbit en EDS-97): la UI solo pide 6, pero un `n` sin
// tope permitiría pedir toda la tabla de un jalón.
const N_CIERRES_MAX = 50;

export async function costoPromedioUltimosCierresImpl(ctx: QueryCtx, n: number) {
  if (!Number.isInteger(n) || n <= 0 || n > N_CIERRES_MAX) {
    throw new ConvexError(`costoPromedioUltimosCierres: n debe ser un entero entre 1 y ${N_CIERRES_MAX}.`);
  }
  const cierres = await ctx.db.query('cierresTurno').order('desc').take(n);
  const kgBuenos = cierres.reduce((s, c) => s + c.kgBuenos, 0);
  const metrosBuenos = cierres.reduce((s, c) => s + c.metrosBuenos, 0);
  const costoTotal = cierres.reduce((s, c) => s + c.costoTotalConsumido, 0);
  return {
    n: cierres.length,
    costoRealPorKg: kgBuenos > 0 ? costoTotal / kgBuenos : 0,
    costoRealPorMetro: metrosBuenos > 0 ? costoTotal / metrosBuenos : 0,
  };
}

export const costoPromedioUltimosCierres = query({
  args: { n: v.number(), token: v.string() },
  handler: async (ctx, { n, token }) => {
    await requireAcceso(ctx, token, 'panel-control');
    return costoPromedioUltimosCierresImpl(ctx, n);
  },
});

// Metas de producción (tarea 6.5) — singleton, igual patrón que
// parametrosProduccion. Lectura: cualquiera con acceso a panel-control.
// Escritura: solo admin — ver nota en updateObjetivos.
export async function getObjetivosImpl(ctx: QueryCtx) {
  const obj = await ctx.db.query('objetivosProduccion').first();
  return obj ?? { turnoL1: 0, turnoL2: 0, semana: 0, mes: 0 };
}

export const getObjetivos = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    await requireAcceso(ctx, token, 'panel-control');
    return getObjetivosImpl(ctx);
  },
});

// EDS-105: EXCEPCIÓN DELIBERADA — se queda en requireRole(['admin']), NO se
// amplía a requireAcceso(ctx, token, 'panel-control'). Editar metas es una
// acción admin-only DENTRO de una pantalla que varios roles pueden abrir
// (mismo patrón que parametros.ts::updateParametros vs. getParametros, y
// que peps.ts::valorInventarioMaterial) — el propio panel-control.html ya
// oculta el control de edición salvo `sessionUser.rol === 'admin'`
// (líneas ~1204/1214). Mapearlo a 'panel-control' ampliaría la escritura a
// compras/calidad/gerencia, que hoy NO la tienen — fuera de alcance de
// EDS-105 (acceso a pantallas, no permisos finos dentro de ellas).
export const updateObjetivos = mutation({
  args: {
    turnoL1: v.number(), turnoL2: v.number(), semana: v.number(), mes: v.number(),
    token: v.string(),
  },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.token, ['admin']);
    if (args.turnoL1 < 0 || args.turnoL2 < 0 || args.semana < 0 || args.mes < 0) {
      throw new ConvexError('updateObjetivos: las metas no pueden ser negativas.');
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
