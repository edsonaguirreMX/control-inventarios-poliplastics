// EDS-111 — catálogo fijo de las 3 vistas internas de Panel de Control que
// un rol personalizable puede tener permitidas. Mismo patrón que
// convex/lib/paginas.ts (fuente única de verdad backend), pero para el
// nivel de "qué ve dentro de panel-control.html" en vez de "a qué pantalla
// puede entrar".
//
// A propósito NO incluye 'admin' — la pestaña "Admin" (Configuración) de
// Panel de Control no es una vista configurable de este catálogo, se queda
// admin-only fija (mismo criterio que gestion-usuarios/gestion-roles en
// convex/lib/paginas.ts::PAGINAS_NO_CONFIGURABLES, aunque aquí ni siquiera
// aparece en la lista — no hay necesidad de una lista de "excluidas"
// separada porque el catálogo completo ya excluye 'admin' de raíz).
export const VISTAS_PANEL = ['compras', 'calidad', 'gerencia'] as const;
export type VistaPanel = (typeof VISTAS_PANEL)[number];
