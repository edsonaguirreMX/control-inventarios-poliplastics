# Auditoría final — EDS-108 (Fase 5 de EDS-103, Roles personalizables)

Cierra la épica EDS-103. No es la primera revisión de este código — cada fase (EDS-104 a EDS-107) ya pasó por su propio ciclo de PR + CI + CodeRabbit + verificación manual antes de mergearse. Este documento es la pasada de confirmación final que exige EDS-108: grep de regresión sobre el backend completo + prueba de los 4 casos límite del sistema de roles contra un deployment real (dev), antes de dar la épica por cerrada.

**Fecha:** 2026-08-18 · **Rama de esta auditoría:** `main` (sin cambios de código — auditoría pura) · **Suite al cierre:** 293/293 tests verdes (`npx vitest run`).

**Cambio respecto al diseño original de EDS-103:** `requireRole`/`Rol` (`convex/lib/auth.ts`) **no se borran** — se quedan permanentemente como el mecanismo de autorización fija de `usuarios.ts`/`roles.ts` (Gestión de Usuarios y Gestión de Roles no pueden depender del sistema dinámico que ellas mismas administran; evita un problema de huevo-gallina y un vector de escalada de privilegios). Decisión tomada en la 2ª ronda de revisión del plan original, antes de arrancar EDS-104 — ver la descripción de EDS-104 en Linear para el detalle completo.

---

## 1. Grep de confirmación: `requireRole` fuera de las excepciones documentadas

```text
grep -rln "requireRole(" convex/*.ts | grep -v '\.test\.ts$'
→ convex/dashboard.ts
→ convex/peps.ts
→ convex/roles.ts
→ convex/usuarios.ts
```

Exactamente los 4 archivos esperados, ninguno más:

| Archivo | Call sites | Motivo |
|---|---|---|
| `usuarios.ts` | 6 (todo el CRUD de usuarios) | **Permanente** — Gestión de Usuarios, admin-only fijo (EDS-104, ajuste 5). |
| `roles.ts` | 6 (todo el CRUD de roles) | **Permanente** — Gestión de Roles, admin-only fijo, mismo motivo. |
| `peps.ts` | 1 (`valorInventarioMaterial`) | **Excepción documentada** (EDS-105) — expone un dato financiero real que "acceso a panel-control" no distingue (Calidad ve existencias, no valor); página-nivel no basta sin permisos finos, fuera de alcance de esta épica. |
| `dashboard.ts` | 1 (`updateObjetivos`) | **Excepción documentada** (EDS-107) — editar metas es admin-only dentro de una pantalla que otros roles también abren; el propio frontend ya oculta el control a no-admin. Migrar a `requireAcceso('panel-control')` habría ampliado la escritura a compras/calidad/gerencia sin que se pidiera. |

Búsqueda complementaria del tipo `Rol` (el union literal de 5 roles que `requireRole` todavía usa) fuera de `lib/auth.ts`/`roles.ts`: **sin resultados** — ningún otro archivo depende del enum fijo.

**Veredicto:** limpio. Nada quedó sin migrar por descuido; las 2 excepciones nuevas de Fase 2/4 están donde deben y documentadas en el propio código, no solo aquí.

---

## 2. Catálogo de 11 páginas — existen y están justificadas

`convex/lib/paginas.ts::PAGINAS` (11 slugs) vs. `public/*.html` real:

| Slug | Archivo HTML | Autorización |
|---|---|---|
| `panel-control` | `panel-control.html` | `requireAcceso('panel-control')` |
| `catalogo-materiales` | `catalogo-materiales.html` | `requireAcceso('catalogo-materiales')` |
| `parametros-produccion` | `parametros-produccion.html` | `requireAcceso('parametros-produccion')` |
| `entradas-costeo` | `entradas-costeo.html` | `requireAcceso('entradas-costeo')` |
| `correccion-capturas` | `correccion-capturas.html` | `requireAcceso('correccion-capturas')` |
| `alertas-configuracion` | `alertas-configuracion.html` | `requireAcceso('alertas-configuracion')` |
| `reporte-diario` | `reporte-diario.html` | `requireAcceso('reporte-diario')` |
| `ajustes-inventario` | `ajustes-inventario.html` | `requireAcceso('ajustes-inventario')` |
| `cierre-turno` | `cierre-turno-propuestas.html` (nombre distinto, a propósito) | `requireAcceso('cierre-turno')` |
| `gestion-usuarios` | `gestion-usuarios.html` | `requireRole(['admin'])` fijo — no configurable |
| `gestion-roles` | `gestion-roles.html` | `requireRole(['admin'])` fijo — no configurable |

11/11 confirmados por inspección directa (`grep -n "requireAcceso\|requireRole" public/*.html`). `login-acceso.html` es el único HTML fuera de este catálogo — correcto, es la pantalla de login misma, sin guard de página.

`PAGINAS_NO_CONFIGURABLES = ['gestion-usuarios', 'gestion-roles']` — confirmado en vivo en la sección 4.4, con las DOS páginas probadas por separado (no solo `gestion-roles`).

---

## 3. `gestion-usuarios.html` / `gestion-roles.html` — admin-only fijo, confirmado

```text
grep -n "requireRole\|requireAcceso" public/gestion-usuarios.html public/gestion-roles.html
```

Ambas usan `window.Session.requireRole(['admin'])` — **ninguna usa `requireAcceso`**. Consistente con el backend (`roles.ts`/`usuarios.ts` sección 1) y con la decisión de diseño de EDS-104/106/107.

---

## 4. Casos límite probados contra dev real (`outstanding-guanaco-989`)

Los 4 escenarios pedidos, cada uno con datos de prueba creados y limpiados en la misma sesión. **Corrección tras revisión de CodeRabbit (PR #40):** la redacción original de esta sección decía "verificación en navegador real de los 4 escenarios" — impreciso. Solo 4.1, 4.2 y 4.4 son verificación end-to-end real (navegador y/o llamadas directas a la API contra dev); 4.3 verifica en vivo el *guardrail que previene* llegar al estado, pero el comportamiento del estado en sí (`requireAcceso`/`auth.me` ante un rol YA inactivo) sigue cubierto solo por prueba unitaria, no por el navegador — ver el detalle en esa subsección.

### 4.1 — Rol con 1-2 páginas permitidas (verificado en navegador)
Rol `auditoria_eds108_dos_paginas` (`catalogo-materiales` + `reporte-diario`), usuario asignado. Confirmado: login aterriza en la primera página de su lista; ambas páginas permitidas cargan con normalidad; intentar `panel-control.html` (no permitida) redirige de vuelta a su página real, sin bucle. `auth.me` devolvió `paginasPermitidas: ["catalogo-materiales","reporte-diario"]` y `rolNombre: "Auditoria EDS108 dos paginas"` — exactos.

### 4.2 — Rol con 0 páginas (verificado en navegador)
Rol `auditoria_eds108_cero_paginas` (`paginas: []`), usuario asignado. Confirmado: `login-acceso.html` muestra el mensaje real ("tu rol ... no tiene acceso a ninguna pantalla") con botón "Cerrar sesión" — sin bucle de redirección (fix de EDS-107, PR #39 commit `1b2e19e`, reconfirmado aquí en un caso nuevo e independiente).

### 4.3 — Rol desactivado (con usuario activo asignado) — verificación mixta, alcance limitado a propósito
El sistema **previene por diseño** llegar a este estado a través de la UI/API normal — `crearUsuario`/`updateUsuario` (`validarRolAsignable`) rechazan asignar un rol inactivo, y `eliminarRol` rechaza desactivar un rol mientras tenga usuarios activos asignados. **Lo único confirmado en vivo aquí es ese rechazo** (la invariante "no puedes llegar a este estado"), no el comportamiento del estado en sí:
```text
roles:eliminarRol sobre "Auditoria EDS108 dos paginas" (con auditoria.a activo)
→ ConvexError: "no se puede eliminar ... hay usuarios activos con ese rol"
```
El comportamiento de `requireAcceso`/`auth.me` cuando SÍ existe un rol inactivo (alcanzable solo por datos preexistentes/migración/un `ctx.db.patch` directo, nunca por la API pública) **no se verificó contra dev en esta auditoría** — se apoya exclusivamente en las pruebas unitarias que sí fuerzan ese estado vía `t.run` + `ctx.db.patch` directo: `auth.test.ts` ("rol inactivo: me sigue devolviendo al usuario, pero paginasPermitidas queda vacío") y `roles.test.ts` ("rechaza sin token / con rol inactivo o inexistente"). No se fuerza el estado en dev vía manipulación directa de base de datos para esta auditoría — sería replicar en un deployment real algo que la app deliberadamente no deja alcanzar por su propia API, y el mismo `ctx.db.patch` que ya lo prueba en unitarias no tiene un equivalente seguro fuera de `convexTest`.

### 4.4 — Rol protegido (admin) y páginas no configurables — verificado contra la API real
Confirmado en vivo, 4 intentos directos vía API contra el rol `admin` real y el catálogo de páginas no configurables (las DOS, no solo una):
```text
roles:actualizarRol  → ConvexError: "Admin" es un rol protegido, no se puede editar.
roles:eliminarRol    → ConvexError: "Admin" es un rol protegido, no se puede eliminar.
roles:crearRol con paginas:["gestion-roles"]    → ConvexError: "gestion-roles" no es asignable
                                                    desde aquí — Gestión de Usuarios y Gestión
                                                    de Roles quedan siempre admin-only.
roles:crearRol con paginas:["gestion-usuarios"] → ConvexError: "gestion-usuarios" no es asignable
                                                    desde aquí — Gestión de Usuarios y Gestión
                                                    de Roles quedan siempre admin-only.
```
Los 2 guardrails de seguridad (protegido, no-configurable — ambos slugs de `PAGINAS_NO_CONFIGURABLES` probados por separado) responden exactamente como está documentado en el código — no solo en tests, en el deployment real.

Todos los usuarios/roles de prueba de esta sección (`auditoria.a`, `auditoria.b`, sus 2 roles, el intento fallido "Intento Escalada") quedaron limpiados (desactivados) al terminar; ninguno persiste activo en dev.

---

## 5. `auth.me` — `rolNombre` / `paginasPermitidas`

Confirmado en 4.1/4.2 (arriba) con datos reales, y cubierto por 5 pruebas unitarias dedicadas en `auth.test.ts` (bypass trae el catálogo completo, rol base trae exactamente sus páginas, rol con páginas específicas, rol inactivo deja `paginasPermitidas` vacío sin lanzar, rol huérfano cae a `rolNombre` = slug crudo).

---

## 6. Verificación técnica

- `npx vitest run`: **293/293** tests, 18 archivos.
- `npm run build`: limpio.
- `git status`: sin cambios de código — esta fase es auditoría pura, no toca `convex/` ni `public/`.

---

## Veredicto final — EDS-103 (Roles personalizables) queda Done

| Fase | Estado |
|---|---|
| EDS-104 (Fase 1 — schema + `requireAcceso`) | ✅ Done, en producción |
| EDS-105 (Fase 2 — migración backend) | ✅ Done, en producción |
| EDS-106 (Fase 3 — frontend `requireAcceso`) | ✅ Done, en producción |
| EDS-110 (hotfix de caché, encontrado en el camino) | ✅ Done, en producción |
| EDS-107 (Fase 4 — pantalla `gestion-roles.html`) | ✅ Done, en producción, validado con rol de prueba real |
| EDS-108 (Fase 5 — esta auditoría) | ✅ Done — sin hallazgos, 0 cambios de código requeridos |

Sin hallazgos bloqueantes ni menores pendientes sobre el sistema de roles en sí. Único ticket de seguimiento abierto, no bloqueante: EDS-109 (`seedRolesBase` no reactiva un rol base existente-pero-inactivo — Minor, aceptado explícitamente como no bloqueante en su momento, sigue en Backlog).

**Nota de proceso (ronda de revisión de CodeRabbit sobre este mismo PR, #40):** la primera versión de este documento sobreclamaba en la sección 4 ("verificación en navegador real de los 4 escenarios") y solo probaba en vivo una de las dos páginas no configurables en 4.4. Ambos son defectos de redacción del documento, no del sistema auditado — corregidos en la misma PR: se agregó la evidencia en vivo faltante (`gestion-usuarios`, 4.4) y se acotó explícitamente el alcance real de 4.3 (guardrail verificado en vivo, comportamiento del estado en sí cubierto solo por prueba unitaria, por diseño de la app). Mismo estándar de honestidad que el resto de esta épica: reportar el alcance exacto de cada verificación, no inflarlo.
