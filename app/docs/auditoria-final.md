# Auditoría final — EDS-66 (10.2, PR8)

Barrido de confirmación de autorización server-side e integridad de inventario sobre el backend completo, ya con las 9 épicas funcionales en `main`. Esto **no es la primera vez que se revisa** cada función — cada tarea de Épicas 1–9 ya incluyó su propio criterio de "hecho cuando... valida el rol correcto" desde que se construyó, y cada PR pasó por auditoría (Codex y/o manual) antes de mergearse. Este documento es la pasada de confirmación final que exige EDS-66, con evidencia citable: línea exacta de cada guard, y el test que lo prueba.

**Metodología:** se leyó el código fuente completo de cada módulo de `convex/` (no solo se buscaron patrones por grep) para confirmar que cada `query`/`mutation`/`action` pública **que debe estar restringida a un rol** llama a `requireRole` (`convex/lib/auth.ts`) antes de tocar `ctx.db`, y que cada función `internal*` (no invocable directo desde el cliente — Convex lo impone a nivel de plataforma) solo se llama desde código que ya autorizó. Donde existía un test automatizado que reproduce el rechazo de rol, se referencia por archivo:línea. Donde no existía, se agregó en esta misma auditoría (ver [Hallazgos](#hallazgos-de-esta-auditoría)).

**Esto NO significa que todas las funciones públicas usen `requireRole`/`requireUser` — hay excepciones intencionales, documentadas explícitamente:**

| Función | Por qué no tiene `requireRole`/`requireUser` |
|---|---|
| `authActions.login` | Es el propio flujo de login — no puede exigir una sesión que todavía no existe. Protegida en cambio por rate limiting atómico (§ mayor de esta ronda) y mensajes de error genéricos. |
| `auth.logout` | Por diseño: el `token` es un UUID de 122 bits — poseerlo ya prueba control de esa sesión, así que no hay guard adicional que agregar (ver tabla de `auth.ts` abajo). |
| `seed.seedInicial` | Action pública, pero protegida por `SEED_SECRET` (variable de entorno del deployment, comparada con `crypto.timingSafeEqual`) en vez de un rol — no puede exigir rol porque se corre ANTES de que exista ningún usuario en la base. |
| `alertas.evaluarAlertas`, `reporteDiario.generarReporteDiario`, `auth.limpiarLoginIntentosExpirados` | `internalMutation` disparadas por cron (`crons.ts`) — no corren en contexto de ningún usuario, Convex ya impide llamarlas desde el cliente. |

Con esas excepciones ya explícitas, el resto de esta auditoría cubre las funciones que sí deben (y sí) validar un rol específico.

**Fecha:** 2026-08-10 · **Rama:** `pr-8-hardening-deploy` · **Suite al cierre:** 182/182 tests verdes (`npx vitest run`).

---

## 1. Autorización server-side por módulo

Convención de la tabla: **Interna** = `internalQuery`/`internalMutation`/`internalAction`, no expuesta a ningún rol porque Convex no permite llamarla desde el cliente — la columna "Rol requerido" en esas filas describe quién autorizó ANTES de invocarla, no un guard propio.

### `auth.ts` / `authActions.ts` — sesión y login

| Función | Tipo | Rol requerido | Test |
|---|---|---|---|
| `login` | action pública | Sin rol (es el propio login, ver excepción arriba) — rate limit atómico por usuario (5 intentos/15min, `admitirIntentoLogin` checa Y reserva en una sola mutation) antes de tocar bcrypt | `auth.test.ts` (8 tests, EDS-70 + bloqueante de esta ronda) |
| `logout` | mutation pública | Sin rol (ver excepción arriba) | — (bajo riesgo, ver nota) |
| `me` | query pública | Ninguno — cualquier usuario autenticado puede leer sus propios datos (`requireUser`, `auth.ts:114`) | implícito en todo test que usa sesión |
| `admitirIntentoLogin`, `limpiarIntentosLogin`, `limpiarLoginIntentosExpirados`, `getUserByUsuario`, `createSession` | internas | Llamadas solo desde `authActions.login` (o desde el cron de limpieza), que ya autorizó/no requiere contexto de usuario | `auth.test.ts` |

### `usuarios.ts` / `usuariosActions.ts` — Gestión de Usuarios

| Función | Tipo | Rol requerido | Test |
|---|---|---|---|
| `listUsuarios` | query | `admin` (`usuarios.ts:19`) | `usuarios.test.ts:18` |
| `updateUsuario` | mutation | `admin` (`usuarios.ts:96`) + invariante "queda ≥1 admin activo" | `usuarios.test.ts:143,156,173` |
| `guardarUsuariosCompleto` | mutation | `admin` (`usuarios.ts:115`) + mismo invariante, atómico | `usuarios.test.ts:156` |
| `eliminarUsuario` | mutation | `admin` (`usuarios.ts:186`) + bloqueo de autodesactivación | `usuarios.test.ts:271,279,299` |
| `reactivarUsuario` | mutation | `admin` (`usuarios.ts:209`) | `usuarios.test.ts:329` |
| `crearUsuario` (action) | pública | Verifica admin vía `ctx.runQuery(internal.usuarios.verificarAdminImpl)` **antes** de hashear con bcrypt (`usuariosActions.ts:39`) | `usuarios.test.ts` (crearUsuario describe) |
| `regenerarPassword` (action) | pública | Igual — `verificarAdminImpl` antes de bcrypt (`usuariosActions.ts:52`) + invalida sesiones del usuario objetivo | `usuarios.test.ts` (regenerarPassword describe) |
| `verificarAdminImpl`, `crearUsuarioImpl`, `actualizarPasswordImpl` | internas | Solo invocables desde las actions de arriba, que ya autorizaron | — |

### `materiales.ts` — Catálogo

| Función | Tipo | Rol requerido | Test |
|---|---|---|---|
| `listCatalogo` | query | `admin` (`materiales.ts:30`) | `materiales.test.ts:19` |
| `updateMaterial` | mutation | `admin` (`materiales.ts:138`) | `materiales.test.ts:74` |
| `guardarCatalogoCompleto` | mutation | `admin` (`materiales.ts:163`), atómico | `materiales.test.ts:156` |

### `parametros.ts` — Parámetros de Producción y Fórmula

| Función | Tipo | Rol requerido | Test |
|---|---|---|---|
| `getParametros` | query | `admin` (`parametros.ts:14`) | `parametros.test.ts:19` |
| `updateParametros` | mutation | `admin` (`parametros.ts:131`) | `parametros.test.ts:127` |
| `updateFormulaCarga` | mutation | `admin` (`parametros.ts:145`) + `verificarFormulaTotalPositiva` (solo materiales activos, EDS-66) | `parametros.test.ts:136` + test MENOR de esta auditoría (materiales activos) |
| `guardarParametrosCompleto` | mutation | `admin` (`parametros.ts:174`), atómico | `parametros.test.ts:238` |

### `entradas.ts` — Entradas con Costeo

| Función | Tipo | Rol requerido | Test |
|---|---|---|---|
| `crearEntrada` | mutation | `operador`/`compras`/`admin` (`entradas.ts:127`) — **solo compras/admin pueden fijar costo**, operador siempre queda `pendiente` | `entradas.test.ts:19,31,45` |
| `crearEntradasBatch` | mutation | Igual, atómico | `entradas.test.ts:132,147,167,175` |
| `costearEntrada` | mutation | `compras`/`admin` (`entradas.ts:169`) | `entradas.test.ts:69,81` |
| `listEntradas`, `listCapasVigentes` | query | `compras`/`admin` (datos financieros) (`entradas.ts:222,240`) | `entradas.test.ts:115` |
| `listMaterialesActivos` | query | Cualquier autenticado (`requireUser`, `entradas.ts:263`) — no expone costo | `entradas.test.ts:123` |
| `eliminarEntradaPendiente` | mutation | `compras`/`admin` (`entradas.ts:278`) | implícito (mismo guard que costearEntrada) |

### `cierres.ts` / `correcciones.ts` / `cierreEngine.ts` — Cierre de turno y correcciones

| Función | Tipo | Rol requerido | Test |
|---|---|---|---|
| `estadoCierresDelDia`, `consumoEsperado` | query | `operador`/`admin` (`cierres.ts:15,45`) | `cierres.test.ts:146,164` |
| `crearCierreTurno` | mutation | `operador`/`admin` (`cierres.ts:80`) | `cierres.test.ts:29,50,77,116,129` |
| `listRegistrosUltimos10Dias`, `getCierre`, `getEntradasDelDia` | query | `admin` (`correcciones.ts:29,50,67`) | `correcciones.test.ts:267` |
| `actualizarCierreTurno` | mutation | `admin` (`correcciones.ts:84`) | `correcciones.test.ts:63,80` |
| `actualizarEntrada`, `actualizarEntradasBatch` | mutation | `compras`/`admin` (`correcciones.ts:211,233`) | `correcciones.test.ts:161,225` |
| `aplicarCierre`, `revertirCierre`, `recapturarCierre` | internas | Solo desde `cierres.ts`/`correcciones.ts`, ya autorizados | ver [§2](#2-integridad-de-inventario) |

### `peps.ts` — Motor PEPS/FIFO

| Función | Tipo | Rol requerido | Test |
|---|---|---|---|
| `crearCapa`, `consumirFIFO`, `revertirConsumo` | internas | Solo desde `cierreEngine.ts`/`entradas.ts`/`correcciones.ts`, ya autorizados — **nunca expuestas directo a un rol** (`peps.ts:213`) | ver [§2](#2-integridad-de-inventario) |
| `existenciaMaterial` | query pública | `compras`/`calidad`/`gerencia`/`admin` (`peps.ts:259`) | **agregado en esta auditoría** — `peps.test.ts` (ver [Hallazgos](#hallazgos-de-esta-auditoría)) |
| `valorInventarioMaterial` | query pública | `compras`/`gerencia`/`admin` (**no** `calidad` — expone costo) (`peps.ts:271`) | **agregado en esta auditoría** |

### `dashboard.ts` — Panel de Control

| Función | Tipo | Rol requerido | Test |
|---|---|---|---|
| `getKPIsHoy` | query | `compras`/`calidad`/`gerencia`/`admin` (`ROLES_DASHBOARD`, `dashboard.ts:172`) | `dashboard.test.ts:34` |
| `produccionPorRango`, `tendenciaMerma`, `tendenciaCosto`, `getObjetivos` | query | Mismo `ROLES_DASHBOARD` (`dashboard.ts:180,198,214,233`) | **agregado en esta auditoría** — antes solo `getKPIsHoy` tenía test explícito de rechazo pese a que las 5 comparten el mismo guard |
| `updateObjetivos` | mutation | `admin` únicamente (`dashboard.ts:245`) | `dashboard.test.ts:240` |

### `alertas.ts` — Alertas

| Función | Tipo | Rol requerido | Test |
|---|---|---|---|
| `listReglas`, `updateRegla`, `guardarReglasCompleto`, `listHistorial` | query/mutation | `admin` (`alertas.ts:36,80,101,189`) | `alertas.test.ts:30` |
| `marcarAlertaLeida`, `marcarTodasLeidas`, `noLeidasParaMi` | mutation/query | Cualquier rol (`CUALQUIER_ROL`, `alertas.ts:135,151,170`) — cada quien solo marca/lee SUS PROPIAS lecturas (`alertasLecturas` por `userId`) | `alertas.test.ts:116,131,142` |
| `evaluarAlertas` | internal, cron | Sin contexto de usuario (disparada por `crons.ts`), no aplica rol | `alertas.test.ts:213` |

### `reporteDiario.ts` — Reporte Diario

| Función | Tipo | Rol requerido | Test |
|---|---|---|---|
| `getConfig`, `guardarConfig`, `listHistorial`, `generarReporteAhora` | query/mutation | `admin` (`reporteDiario.ts:43,58,85,101`) | `reporteDiario.test.ts:26` |
| `generarReporteDiario` | internal, cron | Sin contexto de usuario, no aplica rol | `reporteDiario.test.ts:149` |

### `tiempo.ts`

| Función | Tipo | Rol requerido | Test |
|---|---|---|---|
| `obtenerFechaOperativaHoy` | query | Cualquier autenticado (`requireUser`, `tiempo.ts:14`) — solo expone "qué día es hoy operativamente", sin dato sensible | usado implícitamente en múltiples suites |

### `seed.ts` — siembra inicial (fuera de la tabla de roles a propósito)

`seedInicial` es una `action` pública, pero deliberadamente **no** usa `requireRole`/`requireUser` — no puede exigir una sesión ni un rol porque se corre ANTES de que exista ningún usuario en la base (es lo que crea al primer admin). Su protección es un mecanismo distinto: compara el argumento `seedSecret` contra la variable de entorno `SEED_SECRET` del deployment con `crypto.timingSafeEqual` (resistente a timing attacks), y falla explícito si esa variable no está configurada — sin `SEED_SECRET`, nadie puede sembrar la base ni en desarrollo ni en producción. Además es idempotente (`isSeeded` revisa si `materiales` ya tiene datos antes de insertar nada) y el password del admin inicial nunca queda en texto plano en ningún lado — se regresa una sola vez en la respuesta de la action.

**Conclusión de §1:** de las funciones públicas del backend (`query`/`mutation`/`action`, sin contar internas), las que deben estar restringidas a un rol específico lo están — validado leyendo el código y, donde existe, confirmado llamando la función directo con un token de rol incorrecto en los tests referenciados (exactamente como lo haría alguien golpeando la API de Convex sin pasar por la UI). Las 4 excepciones (`login`, `logout`, `seedInicial`, los `internalMutation` de cron) están explícitas arriba, con su propio mecanismo de protección — no es un guard olvidado, es un diseño distinto para un caso distinto. Ninguna función que sí debía validar rol depende de que el frontend oculte un botón.

---

## 2. Integridad de inventario

Los 3 criterios de aceptación del plan técnico (ver `Documento_Funcionalidades_Control_Materias_Primas.md`) se verifican así:

### a) `kgRestante` nunca queda negativo

`consumirFIFOImpl` (`peps.ts:132`) bloquea con error ANTES de tocar cualquier capa si `disponible < kgAConsumir` y el material no es `esInterno` — nunca resta más de lo que hay. Cubierto por `peps.test.ts:82` ("bloquea por faltante en material normal y no modifica nada").

### b) FIFO real (capa más antigua primero, por fecha real de recepción)

`consumirFIFOImpl` ordena por `by_material_fecha` ascendente — la fecha es `fechaEntrada` (recepción real), nunca la fecha en que se costeó o capturó el registro. Cubierto por `peps.test.ts:10` (2 capas) y `peps.test.ts:46` (fechaEntrada real vs. orden de creación).

### c) Ningún material no-interno se consume por encima de su existencia — Triturado es la única excepción

Mismo guard de (a); la excepción para `esInterno` está en la misma línea (`peps.ts:132`, `&& !material.esInterno`). Cubierto por `peps.test.ts:103` ("Triturado permite faltante sin error, costo siempre $0") y el faltante queda visible en `cierreConsumos.faltanteKg`, nunca oculto.

### Ledger inmutable vs. `kgRestante` cacheado

Cada operación (`crearCapaImpl`, `consumirFIFOImpl`, `revertirConsumoImpl`) escribe en `capaMovimientos` (tipo `generacion`/`consumo`/`reversa_consumo`/`reversa_generacion`/`ajuste_incremento`/`ajuste_decremento`) en la MISMA transacción que actualiza `kgRestante` — nunca uno sin el otro. La reconciliación exacta (`Σ movimientos por tipo == kgRestante`) está probada en `peps.test.ts:180`.

### Recierre y corrección no duplican consumo

`cierreEngine.aplicarCierreImpl`/`revertirCierreImpl` (motor compartido, usado tanto por un recierre del mismo turno como por una corrección administrativa) garantizan que aplicar→revertir deja el estado materializado igual al inicial (`cierreEngine.test.ts:63`), y que aplicar→revertir→aplicar con valores nuevos da el mismo resultado que aplicar una sola vez (`cierreEngine.test.ts:96`) — un recierre real (`cierres.test.ts:77`, "REGRESIÓN: recierre con confirmarRecierre NO duplica el consumo") queda con un solo documento vigente, no dos descuentos.

### Reversa de la capa de Triturado

`revertirCierreImpl` localiza la capa de Triturado del cierre por la ausencia de `reversa_generacion` en su ledger (endurecido en EDS-71 de esta misma ronda de PR8 — antes comparaba `createdAt`, ver commit `71b349e`), bloquea explícito si esa capa ya fue consumida por un cierre posterior (parcial: `cierreEngine.test.ts:187`; total, con la capa ya `agotada:true`: `cierreEngine.test.ts:213`), y es idempotente si se revierte dos veces (`cierreEngine.test.ts:248`). El caso de 3+ rondas de recaptura con múltiples capas voided está cubierto en `cierreEngine.test.ts:135`.

### Corrección de entradas ya costeadas

`actualizarEntrada`/`actualizarEntradasBatch` (`correcciones.ts`) bloquean reducir la cantidad por debajo de lo ya consumido de esa capa (`correcciones.test.ts:139`), y el ajuste es determinístico (no proporcional) vía `ajuste_incremento`/`ajuste_decremento` en el ledger.

**Conclusión de §2:** los 3 criterios de integridad del plan se cumplen y están cubiertos por tests que reproducen escenarios reales (incluyendo los bugs de auditorías anteriores ya corregidos: recierre duplicado, guardado parcial de batch, selección de capa Triturado por timestamp).

---

## 3. Hardening de seguridad — XSS almacenado (incluido en PR8 por instrucción explícita)

Durante la auditoría manual de PR6 (2026-08-10) se encontró y corrigió XSS almacenado en `catalogo-materiales.html`/`parametros-produccion.html` (interpolación sin escapar de `nombre`/`variante`/`nota` en HTML armado a mano — commit `6ee113d`, ya en `main`). Al investigar el alcance real se confirmó que el mismo patrón (`user.nombre` sin escapar en el badge de sesión) existía en las **7 páginas restantes** ya mergeadas antes de esta ronda de PR8: `gestion-usuarios`, `alertas-configuracion`, `correccion-capturas`, `entradas-costeo`, `reporte-diario`, `panel-control`, `cierre-turno-propuestas`.

**Corregido en esta misma rama (commit `dbe5932`)** — mismo `escapeHtml()` aplicado al badge de sesión de las 7 páginas. Verificado en navegador con el escenario de ataque real: un usuario "víctima" con `nombre = "><img src=x onerror=alert(1)>` (simulando que un admin ya lo editó así vía Gestión de Usuarios) inicia sesión y su propio badge renderiza el payload como texto inerte, confirmado en `panel-control.html` y `cierre-turno-propuestas.html` (las dos variantes de código distintas del bloque de sesión).

Sin cobertura de `convex-test` (es renderizado puro del cliente) — la verificación es manual en navegador, documentada en el mensaje del commit `dbe5932`.

---

## Hallazgos de esta auditoría

| # | Hallazgo | Severidad | Acción |
|---|---|---|---|
| 1 | `existenciaMaterial`/`valorInventarioMaterial` (`peps.ts`) sin ningún test — código correcto (verificado leyendo), pero riesgo real: expone datos financieros gateados por rol y ninguna pantalla las llama hoy, así que un regresión ahí no la detectaría ni un smoke test manual de la UI | Mayor (gap de test, no bug de código) | 5 tests agregados en `peps.test.ts` |
| 2 | `produccionPorRango`/`tendenciaMerma`/`tendenciaCosto`/`getObjetivos` (`dashboard.ts`) sin test de rechazo de rol propio (código correcto, mismo patrón que `getKPIsHoy` que sí lo tenía) | Menor | 1 test agregado en `dashboard.test.ts` |
| 3 | `verificarFormulaTotalPositiva` sumaba TODAS las filas de `formulaCarga`, no solo materiales activos | Menor (ya reportado y corregido en la auditoría manual de PR6, commit `6ee113d`) | Referenciado aquí, no duplicado |
| 4 | XSS almacenado en badge de sesión de 7 páginas ya en `main` (ver §3) | Mayor | Corregido, commit `dbe5932` |
| 5 | **No Go de PR #9 — carrera en el rate limit de login**: `verificarRateLimitLogin` (lectura) y `registrarIntentoFallidoLogin` (escritura, después de bcrypt) eran llamadas separadas — bajo intentos concurrentes, varias solicitudes podían leer "no bloqueado" antes de que ninguna registrara su fallo, así que el límite de 5 no se respetaba bajo fuerza bruta en paralelo (el conteo final SÍ terminaba correcto, porque Convex serializa mutations, pero el gate que debía frenar bcrypt de más ya se había pasado de largo en todas) | **Bloqueante** | Reescrito como una sola mutation atómica `admitirIntentoLogin` que checa Y reserva en la misma transacción — cierra la carrera porque Convex serializa llamadas concurrentes contra el mismo documento. Test de 6 intentos concurrentes (`Promise.allSettled`, no un `for` secuencial) agregado en `auth.test.ts`, confirmando 5 admitidos y 1 rechazado bajo concurrencia real. |
| 6 | `loginIntentos` sin `expiresAt` ni limpieza — crecía sin límite con cada usuario (real o inventado por un atacante) que alguna vez fallara un login | Mayor | Campo `expiresAt` + índice `by_expiresAt` en el schema; nueva `limpiarLoginIntentosExpirados` (cron cada hora, acotada a 200 filas por corrida); test de limpieza agregado |
| 7 | Este mismo documento sobredeclaraba "todas las funciones públicas usan requireRole/requireUser" sin listar las excepciones intencionales (`login`, `logout`, `seedInicial`, internas de cron) | Mayor (documentación) | Corregido — ver tabla de excepciones al inicio de §1 y la nueva subsección de `seed.ts` |

Con las 4 excepciones intencionales ya explícitas (§1, tabla de excepciones), no se encontraron funciones públicas que DEBIERAN validar rol y no lo hicieran, ni casos donde el frontend oculta una acción que el backend permitiría de todos modos.

---

## Veredicto

**EDS-66 (10.2): completo, tras una ronda de No-Go sobre la propia auditoría (PR #9, 2026-08-10).** El No-Go encontró un bloqueante real (carrera en el rate limit, no cubierta por los tests secuenciales originales) y 3 mayores (limpieza de `loginIntentos`, y dos correcciones a este mismo documento) — los 4 corregidos en esta ronda, junto con los 3 menores de estilo (ver commit). Autorización server-side confirmada módulo por módulo con evidencia citable, incluidas sus excepciones intencionales explícitas; integridad de inventario confirmada contra los 3 criterios del plan; 9 tests nuevos en total entre la auditoría original y esta ronda de fixes, cerrando gaps de cobertura y de concurrencia reales (no hipotéticos); hardening de XSS de PR8 documentado con su verificación manual. Suite completa: **182/182** (`npx vitest run`).
