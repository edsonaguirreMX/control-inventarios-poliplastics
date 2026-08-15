// EDS-88: única fuente de verdad del punto de reorden teórico — antes
// vivía duplicado (con leve divergencia intencional) en materiales.ts
// (Catálogo) y dashboard.ts (Panel de Control, que usaba consumo REAL
// promedio en vez de teórico). El usuario pidió unificar: Catálogo de
// Materiales manda, Panel de Control es un espejo. Esta función es el
// único lugar que calcula "consumo diario" y "punto de reorden
// calculado" — listCatalogo y calcularKPIsHoyImpl la llaman igual,
// así ya no pueden divergir por un cambio hecho en un solo lado.

export interface ParametrosConsumoTeorico {
  cargasPorTurno: number;
  turnosPorDia: number;
  // Cuántas líneas se consideran activas — antes hardcoded a 2
  // (NUM_LINEAS en materiales.ts). El spec fija un máximo físico de 2
  // líneas, pero el usuario pidió poder bajarlo a 1 cuando solo opera
  // una línea, sin tener que tocar el resto del sistema.
  lineasActivas: number;
}

export function consumoDiarioTeorico(kgPorCarga: number, params: ParametrosConsumoTeorico): number {
  return kgPorCarga * params.cargasPorTurno * params.turnosPorDia * params.lineasActivas;
}

// leadTimeDias/stockSeguridadDias pueden venir null desde el catálogo
// (material sin capturar todavía) — mismo default de 7 días de stock de
// seguridad y 0 de lead time que ya usaban ambos cálculos por separado.
export function puntoReordenTeorico(
  consumoDiario: number,
  leadTimeDias: number | null,
  stockSeguridadDias: number | null
): number {
  const leadTime = leadTimeDias ?? 0;
  const stockSeguridad = stockSeguridadDias ?? 7;
  return consumoDiario * (leadTime + stockSeguridad);
}
