// EDS-104 (Fase 1 de EDS-103, roles personalizables) — catálogo fijo de
// páginas del sistema. Fuente única de verdad en el BACKEND (segunda
// ronda de revisión: antes vivía inline en lib/auth.ts, se separa a su
// propio archivo para que sea inequívoco que esto es el catálogo
// canónico, no un detalle interno de autenticación). El frontend
// (public/js/session.js) mantiene su propia copia — igual que
// `alertasReglas.destinatariosRoles` ya vivía como texto libre sin un
// archivo compartido real entre cliente/servidor — pero DEBE coincidir
// slug por slug con esta lista; cualquier cambio aquí se refleja ahí a
// mano.
//
// El `slug` de cada página es un nombre LÓGICO, no necesariamente el
// nombre del archivo HTML — mapeo explícito para evitar divergencias
// (hallazgo de revisión: "cierre-turno" vs "cierre-turno-propuestas.html"
// se ve como un typo si no queda documentado):
//
//   slug                    → archivo HTML real
//   -----------------------   ------------------------------
//   panel-control            panel-control.html
//   catalogo-materiales      catalogo-materiales.html
//   parametros-produccion    parametros-produccion.html
//   entradas-costeo          entradas-costeo.html
//   correccion-capturas      correccion-capturas.html
//   alertas-configuracion    alertas-configuracion.html
//   reporte-diario           reporte-diario.html
//   ajustes-inventario       ajustes-inventario.html
//   cierre-turno             cierre-turno-propuestas.html  ← nombres distintos, a propósito
//   gestion-usuarios         gestion-usuarios.html
//   gestion-roles            gestion-roles.html (Fase 4, todavía no existe)
export const PAGINAS = [
  'panel-control', 'catalogo-materiales', 'parametros-produccion', 'entradas-costeo',
  'correccion-capturas', 'alertas-configuracion', 'reporte-diario', 'ajustes-inventario',
  'cierre-turno', 'gestion-usuarios', 'gestion-roles',
] as const;
export type Pagina = (typeof PAGINAS)[number];

// Páginas que NUNCA son configurables por un rol personalizable — evita que
// un rol pueda auto-otorgarse (o que un admin distraído le otorgue) acceso
// a la pantalla que administra quién tiene acceso a qué, lo cual sería una
// escalada de privilegios real. Reutilizado por convex/roles.ts.
export const PAGINAS_NO_CONFIGURABLES: Pagina[] = ['gestion-usuarios', 'gestion-roles'];
