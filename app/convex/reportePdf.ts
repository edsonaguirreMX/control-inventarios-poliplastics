import { internalQuery } from './_generated/server';
import type { QueryCtx } from './_generated/server';
import {
  calcularKPIsHoyImpl,
  produccionPorRangoImpl,
  tendenciaCostoImpl,
  kpisPorRangoImpl,
  costoPromedioUltimosCierresImpl,
  getObjetivosImpl,
} from './dashboard';

// EDS-113 — PDF adjunto al correo real de Reporte Diario. Replica EXACTO el
// resumen ejecutivo que ya arma `renderReporteEjecutivo()` en
// panel-control.html:959-1029 (mismo "Reporte Directivo" de EDS-99), solo
// que aquí se junta en el servidor (sin navegador) para poder adjuntarlo a
// un correo real. A propósito NO recalcula ningún KPI — cada número sale
// de las mismas funciones `*Impl` de dashboard.ts que ya usa el Panel de
// Control; lo único que se hace aquí es la misma agregación ligera
// (filtros/sumas sobre datos ya calculados) que el cliente ya hace, para
// no depender de una query nueva que no existe.

export async function datosReportePdfImpl(ctx: QueryCtx) {
  const kpis = await calcularKPIsHoyImpl(ctx);
  const semana = await kpisPorRangoImpl(ctx, 7);
  const seisCierres = await costoPromedioUltimosCierresImpl(ctx, 6);
  const prod30 = await produccionPorRangoImpl(ctx, 30);
  const costo30 = await tendenciaCostoImpl(ctx, 30);
  const objetivos = await getObjetivosImpl(ctx);

  // Alertas/inventario — mismo cálculo que panel-control.html:977-986.
  const materialesConReorden = kpis.materiales.filter((m) => m.reorderKg !== null);
  const nCrit = materialesConReorden.filter((m) => m.status === 'crit').length;
  const nWarn = materialesConReorden.filter((m) => m.status === 'warn').length;
  const masUrgente =
    materialesConReorden
      .filter((m) => m.status === 'crit')
      .sort((a, b) => (a.coberturaDias ?? Infinity) - (b.coberturaDias ?? Infinity))[0] ?? null;

  // Tendencia de costo — últimos 7 días naturales, mismo slice que el
  // cliente (`COSTO_30.slice(-7)`, panel-control.html:995-996).
  const costoTendencia7 = costo30.slice(-7);

  // Producción semana/mes — mismo cálculo que `metrosPlantaDia()` + sumas
  // de panel-control.html:1016-1017 (índices 23..29 = última semana,
  // 0..29 = último mes, sobre la misma serie de 30 días).
  const metrosDia = (p: (typeof prod30)[number]) => p.linea1Turno1 + p.linea1Turno2 + p.linea2Turno1 + p.linea2Turno2;
  const semanaTotal = prod30.slice(-7).reduce((s, p) => s + metrosDia(p), 0);
  const mesTotal = prod30.reduce((s, p) => s + metrosDia(p), 0);

  return {
    fecha: kpis.fecha,
    kpis,
    semana,
    seisCierres,
    objetivos,
    costoTendencia7,
    nCrit,
    nWarn,
    totalMaterialesConReorden: materialesConReorden.length,
    totalMateriales: kpis.materiales.length,
    masUrgente: masUrgente ? { nombre: masUrgente.nombre, coberturaDias: masUrgente.coberturaDias } : null,
    semanaTotal,
    mesTotal,
  };
}

export type DatosReportePdf = Awaited<ReturnType<typeof datosReportePdfImpl>>;

export const datosReportePdf = internalQuery({
  args: {},
  handler: async (ctx) => datosReportePdfImpl(ctx),
});

// ---------------------------------------------------------------------
// Construcción del PDF — función pura (sin ctx), toma los datos ya
// resueltos de arriba y los dibuja con pdf-lib. Ningún cálculo de negocio
// nuevo aquí, solo formateo — mismo criterio que renderReporteEjecutivo()
// en el cliente, que tampoco recalcula nada.
// ---------------------------------------------------------------------

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const ANCHO_PAGINA = 612; // Letter, en puntos
const ALTO_PAGINA = 792;
const MARGEN_X = 50;

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('es-MX');
}
function fmtMoney(n: number): string {
  return `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Devuelve directo el base64 (vía `doc.saveAsBase64()`, confirmado
// funcionando en el runtime normal de Convex actions sin 'use node' — ver
// spike de EDS-113) — evita escribir un encoder manual de Uint8Array a
// base64 aparte, pdf-lib ya lo trae integrado.
export async function construirPdfReporteBase64(datos: DatosReportePdf): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([ANCHO_PAGINA, ALTO_PAGINA]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const negro = rgb(0.15, 0.15, 0.15);
  const gris = rgb(0.45, 0.45, 0.45);
  let y = ALTO_PAGINA - 50;

  function linea(texto: string, opts: { size?: number; bold?: boolean; gris?: boolean; gap?: number } = {}) {
    const size = opts.size ?? 10;
    page.drawText(texto, { x: MARGEN_X, y, size, font: opts.bold ? fontBold : font, color: opts.gris ? gris : negro });
    y -= opts.gap ?? size + 6;
  }
  function separador() {
    page.drawLine({ start: { x: MARGEN_X, y }, end: { x: ANCHO_PAGINA - MARGEN_X, y }, thickness: 0.5, color: gris });
    y -= 12;
  }

  const generadoEn = new Date().toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });

  linea('Tejaflex — Reporte Diario Ejecutivo', { size: 18, bold: true, gap: 22 });
  linea(`Datos al último cierre: ${datos.fecha} · Generado: ${generadoEn}`, { size: 9, gris: true, gap: 20 });

  // Sección 1 — Resumen último cierre vs. última semana.
  linea(`Resumen — Último cierre (${datos.fecha}) vs. Última semana`, { size: 11, bold: true, gap: 16 });
  const colX = [MARGEN_X, MARGEN_X + 220, MARGEN_X + 360];
  const filasResumen: [string, string, string][] = [
    ['Métrica', 'Último cierre', 'Última semana'],
    ['% Merma', `${datos.kpis.pctMermaUltimoCierre.toFixed(1)}%`, `${datos.semana.pctMerma.toFixed(1)}%`],
    ['Producción', `${fmtNum(datos.kpis.produccionUltimoCierreMetros)} m`, `${fmtNum(datos.semana.produccionMetros)} m`],
    ['Costo real / kg', fmtMoney(datos.kpis.costoRealPorKgUltimoCierre), fmtMoney(datos.semana.costoRealPorKg)],
    ['Costo real / metro', fmtMoney(datos.kpis.costoRealPorMetroUltimoCierre), fmtMoney(datos.semana.costoRealPorMetro)],
  ];
  filasResumen.forEach((fila, i) => {
    const esHeader = i === 0;
    fila.forEach((texto, col) => page.drawText(texto, { x: colX[col], y, size: 10, font: esHeader ? fontBold : font, color: negro }));
    y -= 16;
    if (esHeader) separador();
  });
  y -= 8;

  // Sección 2 — Inventario/alertas (tolerante a catálogo vacío: 0/0/ninguno, no truena).
  linea(`Inventario: ${fmtMoney(datos.kpis.valorInventarioTotal)} MXN (${datos.totalMateriales} materias primas)`, { gap: 14 });
  linea(`Alertas: ${datos.nCrit} críticos, ${datos.nWarn} por vencer de ${datos.totalMaterialesConReorden}`, { gap: 14 });
  const urgenteTexto = datos.masUrgente
    ? `${datos.masUrgente.nombre} (${datos.masUrgente.coberturaDias !== null ? `${datos.masUrgente.coberturaDias.toFixed(0)} días de cobertura` : 'sin fórmula'})`
    : 'ninguno';
  linea(`Más urgente: ${urgenteTexto}`, { gap: 22 });

  // Sección 3 — Tendencia de costo, últimos 7 días (tolerante a 0 cierres: filas en $0.00, nunca truena).
  linea('Costo real / kg — tendencia diaria (últimos 7 días)', { size: 11, bold: true, gap: 16 });
  if (datos.costoTendencia7.length === 0) {
    linea('Sin cierres capturados en este periodo.', { gris: true, gap: 20 });
  } else {
    page.drawText('Fecha', { x: colX[0], y, size: 10, font: fontBold, color: negro });
    page.drawText('Costo real ($/kg)', { x: colX[1], y, size: 10, font: fontBold, color: negro });
    y -= 16;
    separador();
    for (const d of datos.costoTendencia7) {
      page.drawText(d.fecha, { x: colX[0], y, size: 10, font, color: negro });
      page.drawText(fmtMoney(d.costoRealPorKg), { x: colX[1], y, size: 10, font, color: negro });
      y -= 14;
    }
    y -= 8;
  }

  // Sección 4 — Promedio últimos N cierres (tolerante a 0 cierres reales: "—").
  const seisTexto = datos.seisCierres.n > 0
    ? `Costo real / kg (promedio últimos ${datos.seisCierres.n} cierres): ${fmtMoney(datos.seisCierres.costoRealPorKg)} · Costo real / metro: ${fmtMoney(datos.seisCierres.costoRealPorMetro)}`
    : 'Costo real / kg (promedio últimos cierres): — (sin cierres capturados todavía)';
  linea(seisTexto, { gap: 20 });

  // Sección 5 — Producción semana/mes vs. objetivo.
  const semanaPct = datos.objetivos.semana > 0 ? (datos.semanaTotal / datos.objetivos.semana) * 100 : 0;
  const mesPct = datos.objetivos.mes > 0 ? (datos.mesTotal / datos.objetivos.mes) * 100 : 0;
  linea(`Producción semana: ${fmtNum(datos.semanaTotal)} m${datos.objetivos.semana > 0 ? ` de ${fmtNum(datos.objetivos.semana)} m objetivo (${semanaPct.toFixed(0)}%)` : ''}`, { gap: 14 });
  linea(`Producción mes: ${fmtNum(datos.mesTotal)} m${datos.objetivos.mes > 0 ? ` de ${fmtNum(datos.objetivos.mes)} m objetivo (${mesPct.toFixed(0)}%)` : ''}`, { gap: 14 });

  return doc.saveAsBase64();
}
