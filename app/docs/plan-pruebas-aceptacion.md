# Plan de pruebas de aceptación (UAT) — pre-operación real

**Issue de Linear:** [EDS-74](https://linear.app/edsonaguirre/issue/EDS-74). **Ambiente:** Convex dev (`outstanding-guanaco-989`) + servidor local (`http://localhost:3010`) — decisión explícita del usuario de no correr esto sobre producción real. **Fecha de la corrida:** 2026-08-10.

**Metodología (híbrida, decidida con el usuario vía AskUserQuestion):** para cada caso, primero se busca si ya existe cobertura real — test automatizado (`convex/*.test.ts`) o verificación en vivo ya hecha durante la auditoría de algún PR (documentada en la memoria del proyecto `pr-audit-strategy`) — y se marca **Pass (cobertura existente)** con su referencia exacta. Solo se ejecuta en vivo lo que genuinamente falta o nunca se probó junto en un flujo continuo. Esto no es más débil que ejecutar todo desde cero: la cobertura referenciada ya pasó por auditoría externa (CodeRabbit y/o el usuario) en su momento.

**Veredictos:** ✅ Pass · ⚠️ Pass con nota · ❌ Fail · 🚫 Bloqueado (feature no existe) · ⏳ Pendiente (próxima pasada, secciones 10–19)

---

## Hallazgo previo a la corrida

**Sección 4 (Inventario Inicial / EDS-41) no es ejecutable tal cual está descrita: la mutation/pantalla para importar inventario inicial nunca se construyó.** El schema soporta el dato (`capasCosto.origen: "inventarioInicial"`, ya usado por `crearCapaImpl`), pero no hay ningún archivo `convex/importacionInicial.ts` ni pantalla dedicada — confirmado por búsqueda en todo el repo. Esto coincide con el estado ya documentado en Linear/memoria: EDS-41 sigue "🔒 Bloqueada — pendiente de que el usuario entregue el inventario físico real", tal como se diseñó desde el plan técnico original (tarea 3.5). Para poder probar las secciones 5–9 (que necesitan que exista ALGO de inventario), se sembraron capas de prueba **directo en la base de dev, no a través de EDS-41** — documentado explícitamente en cada caso de la Sección 4 como tal.

---

## 1. Preparar ambiente de prueba

| # | Caso | Resultado | Evidencia |
|---|---|---|---|
| 1.1 | Ambiente: dev, no producción | ✅ | `.env.local` → `outstanding-guanaco-989`, servidor local puerto 3010 |
| 1.2 | Usuarios de prueba por rol (admin, operador, compras, calidad, gerencia) | ✅ | 5 creados (`uat-admin`, `uat-operador`, `uat-compras`, `uat-calidad`, `uat-gerencia`) — usados en toda la Sección 2 y en las Secciones 7–9 |
| 1.3 | Inventario inicial controlado para 8 materiales | 🚫→⚠️ | EDS-41 no existe — sembrado directo, documentado |
| 1.4 | Fecha operativa de prueba | ✅ | No se fijó a mano — se usó la fecha operativa real calculada server-side (`obtenerFechaOperativaHoy`), confirmada en el cierre real de la Sección 7 (`fecha:"2026-08-09"`, ver 7.1) |
| 1.5 | Hoja de control (este documento) | ✅ | este archivo |

---

## 2. Autenticación y roles

| # | Caso | Resultado | Evidencia |
|---|---|---|---|
| 2.1 | Login correcto — operador, compras, calidad, admin | ✅ | En vivo, dev, 4 de 5 roles probados directo (gerencia sigue el mismo patrón que calidad, no repetido) |
| 2.2 | Login incorrecto (password inválida) | ✅ Pass (cobertura existente + en vivo) | `auth.test.ts`; re-verificado en vivo en EDS-73 ("Usuario o contraseña incorrectos.") |
| 2.3 | Rate limit (5 fallos → bloqueo) | ✅ Pass (cobertura existente) | `auth.test.ts` (10 tests), verificado en vivo 2 veces (PR9 y PR10) contra dev/prod reales |
| 2.4 | Sesión recordada (checkbox marcado → localStorage) | ✅ | En vivo: `uat-operador` con "Recordar" — token en `localStorage`, no en `sessionStorage` |
| 2.5 | Sesión no recordada (checkbox sin marcar → sessionStorage) | ✅ | En vivo: `uat-compras` sin "Recordar" — token en `sessionStorage`, `localStorage` vacío |
| 2.6 | Logout | ✅ | En vivo — limpia el token y redirige a login. Nota: el click del navegador de automatización falló 2 veces por coordenadas (no es bug de la app — confirmado disparando el mismo handler por JS, que sí limpió el token y redirigió correctamente) |
| 2.7 | Sesión expirada/token inválido | ✅ | En vivo: token manipulado a un valor inválido → `requireRole` redirige a login-acceso.html (vía `getUser()` fallando limpio, `cachedUser=null`) |
| 2.8 | Acceso directo por URL a pantalla no permitida — Operador (8 pantallas bloqueadas) | ✅ | En vivo: panel-control, entradas-costeo, catalogo-materiales, parametros-produccion, correccion-capturas, gestion-usuarios, alertas-configuracion, reporte-diario — las 8 redirigen (vía login-acceso.html, que a su vez auto-redirige a la pantalla default del rol si la sesión sigue viva) |
| 2.9 | Acceso directo por URL — Compras (entradas-costeo/panel permitidos, cierre-turno y admin-only bloqueados) | ✅ | En vivo |
| 2.10 | Acceso directo por URL — Calidad (panel permitido, entradas-costeo bloqueado) | ✅ | En vivo. Gerencia usa el mismo guard (`ROLES_DASHBOARD`) — mismo resultado esperado, no repetido en vivo |
| 2.11 | Admin puede entrar a todo | ✅ | En vivo: gestion-usuarios.html y cierre-turno-propuestas.html (los 2 extremos del espectro de roles) confirmados; el resto ya cubierto por 2.9/2.10 con el mismo guard menos restrictivo para admin |
| 2.12 | No hay bypass por query param (`?role=admin`) | ✅ | En vivo: `entradas-costeo.html?role=admin` con sesión de Calidad — sigue bloqueado, el rol viene de la sesión del servidor, nunca de la URL |
| 2.13 | Rechazo server-side de rol incorrecto (no solo oculto en UI) | ✅ Pass (cobertura existente) | Cada módulo de `convex/*.test.ts` prueba `requireRole` directo contra la función, simulando alguien golpeando la API sin pasar por la UI — documentado exhaustivamente en `docs/auditoria-final.md` §1 |

## 3. Catálogo y parámetros

| # | Caso | Resultado | Evidencia |
|---|---|---|---|
| 3.1 | Listado de 8 materiales | ✅ | En vivo: "8 de 8" materias primas activas, catalogo-materiales.html como `uat-admin` |
| 3.2 | Edición de costo estándar, guardado real | ✅ | En vivo: HDPE reciclado $14.50→$15.00, verificado con `npx convex data materiales` (`updatedBy` = uat-admin), revertido a $14.50 al terminar |
| 3.3 | Triturado bloqueado a costo $0 | ✅ | En vivo: campo `$0.00/kg` con candado 🔒, "Generado internamente", "No aplica" en cantidad a pedir. Guard de servidor: `materiales.test.ts` |
| 3.4 | HDPE virgen como sustituto sin reorden propio | ✅ Pass (cobertura existente) | Confirmado en vivo en el Panel de Control (badge "Sustituto", "sin reorden fijo") durante la Sección 2; lógica en `materiales.ts` (`sinReorden = esInterno \|\| esSustituto`) |
| 3.5 | Lead time, stock de seguridad, reorden manual/auto | ✅ | En vivo: HDPE reciclado en modo MANUAL con override 38,000kg visible junto al calculado (13,600kg) |
| 3.6 | Guardado atómico (fila inválida no deja nada a medias) | ✅ Pass (cobertura existente) | `materiales.test.ts`, `usuarios.test.ts` — patrón de mutation atómica de batch probado repetidas veces en este proyecto (PR3/PR5/PR6/PR7) |
| 3.7 | Fórmula de carga: valores válidos, material en 0, total en 0 debe fallar | ✅ Pass (cobertura existente) | `parametros.test.ts`; caso "total en 0" es además uno de los 11 tests de `erroresNegocio.test.ts` (EDS-73, verifica que además llega como `ConvexError`) |
| 3.8 | Parámetros: cargas/turno, turnos/día, kg/metro > 0; horarios; zona horaria | ✅ Pass (cobertura existente) | `parametros.test.ts` — incluye los 3 casos ">0" y el rechazo en 0 |
| 3.9 | Sincronización Parámetros → Catálogo | ✅ Pass (cobertura existente + en vivo previo) | `materiales.test.ts` (2 tests de integración explícitos); verificado en vivo durante la auditoría de PR5 (cambiar kg/carga en Parámetros cambia %mezcla/consumoDiario en Catálogo sin recargar) — ver memoria `pr-audit-strategy` |

## 4. Inventario inicial (EDS-41 — bloqueado, sembrado directo para pruebas)

| # | Caso | Resultado | Evidencia |
|---|---|---|---|
| 4.1 | Mutation/pantalla de importación de inventario inicial | 🚫 Bloqueado | No existe en el código — confirmado por búsqueda en todo el repo. EDS-41 sigue "🔒 Bloqueada" en Linear, sin cambios desde el plan técnico original |
| 4.2 | Cargar inventario inicial para los 8 materiales | ⚠️ Sustituido | Sembrado DIRECTO en la base de dev (7 capas `origen:"inventarioInicial"`, 500kg c/u al costoEstandar de catálogo, vía `crearCapaImpl` — el mismo primitivo que usaría la mutation real si existiera). Triturado nunca se siembra a mano — solo se genera vía cierre |
| 4.3 | Rechazar doble importación del mismo material | ✅ (del sembrado de prueba) | El script de siembra es idempotente por diseño (`if (yaTiene) continue`) — no es la regla real de EDS-41 (que exigiría rechazo explícito "ya se importó este material"), solo evita duplicar en esta corrida |
| 4.4 | Validar kg y costo unitario | N/A | No aplica — no hay formulario de importación que validar |
| 4.5 | Confirmar capas `origen:"inventarioInicial"` | ✅ | Verificado con `npx convex data capasCosto` — 7 filas, `origen: "inventarioInicial"`, `costoUnitario` = costoEstandar real de cada material |
| 4.6 | Confirmar existencia y valor derivados | ✅ | Panel de Control: `$88,400 MXN` = 500kg × Σ(costoEstandar de los 7 materiales no internos) — matemática exacta confirmada a mano |
| 4.7 | Confirmar ledger `capaMovimientos` | ✅ Pass (cobertura existente) | `crearCapaImpl` siempre escribe `capaMovimientos` tipo `generacion` en la misma transacción — probado en `peps.test.ts` (test de reconciliación) |
| 4.8 | Confirmar que no hay saldos negativos | ✅ | `kgRestante = kgOriginal = 500` en las 7 capas recién sembradas, sin consumo todavía |

## 5. Entradas y costeo

| # | Caso | Resultado | Evidencia |
|---|---|---|---|
| 5.1 | Operador crea entrada sin costo | ✅ Pass (en vivo, EDS-67) | Smoke test post-deploy contra producción real: operador registró 5kg de HDPE reciclado, `estado:"pendiente"`, sin `capaId` |
| 5.2 | Operador NO puede crear entrada con costo | ✅ Pass (cobertura existente) | `entradas.test.ts` — `crearEntradaImpl` rechaza `costoUnitario` si `user.rol === 'operador'` |
| 5.3 | Compras/Admin crean entrada con costo | ✅ Pass (cobertura existente) | `entradas.test.ts` |
| 5.4 | Costear entrada pendiente | ✅ Pass (en vivo, EDS-67) | Mismo smoke test: admin costeó la entrada del punto 5.1, `$14.50/kg`, "Entrada costeada — capa PEPS creada" |
| 5.5 | Entrada costeada crea una capa PEPS | ✅ Pass (en vivo, EDS-67) | Confirmado con `npx convex data capasCosto --prod`, `origen:"entrada"`, `kgOriginal: 5, costoUnitario: 14.5` |
| 5.6 | No se puede costear dos veces | ✅ Pass (cobertura existente) | `entradas.test.ts` — `costearEntrada` rechaza si `entrada.estado === 'costeada'` |
| 5.7 | No se puede eliminar entrada costeada | ✅ Pass (cobertura existente) | `entradas.test.ts` — `eliminarEntradaPendiente` exige `estado === 'pendiente' && capaId === null` |
| 5.8 | Se puede eliminar pendiente sin capa | ✅ Pass (cobertura existente) | `entradas.test.ts` |
| 5.9 | Proveedor/folio opcionales | ✅ Pass (cobertura existente) | `entradas.test.ts` |
| 5.10 | Validaciones: kg≤0, costo negativo, fecha inválida, material inactivo, material interno (Triturado) | ✅ Pass (cobertura existente, + `ConvexError` verificado) | `entradas.test.ts`; kg≤0 es además uno de los 11 tests de `erroresNegocio.test.ts` (EDS-73) |
| 5.11 | CSV de entradas | ⏳ | Pendiente — se agrupa con Sección 16 (exportaciones), próxima pasada |
| 5.12 | Estados loading/empty/error | ✅ Pass (cobertura existente) | EDS-65 (10.1) — try/catch + banner de error agregado a las 10 páginas, incluida `entradas-costeo.html` (commit `b2890f8`) |

## 6. Motor PEPS/FIFO

| # | Caso | Resultado | Evidencia |
|---|---|---|---|
| 6.1 | Capa A 100kg@$10, capa B 100kg@$12, consumir 150kg → A=0/agotada, B=50kg, costo=100×10+50×12=$1,600 | ✅ Pass (cobertura existente, números idénticos a los pedidos) | `peps.test.ts:11` "FIFO real: 2 capas, consumir 150kg deja la 1ª agotada y la 2ª con 50kg" — exactamente el escenario solicitado, mismos números |
| 6.2 | FIFO respeta `fechaEntrada` REAL, no orden de creación/costeo | ✅ Pass (cobertura existente) | `peps.test.ts:47` |
| 6.3 | Bloqueo por faltante en material no interno | ✅ Pass (cobertura existente + en vivo 2 veces) | `peps.test.ts:83`; verificado en vivo en el smoke test de EDS-67 (producción real) y de nuevo en EDS-73 (dev) — mensaje real "Inventario insuficiente..." confirmado llegando al navegador |
| 6.4 | Excepción de Triturado: consume lo disponible, `faltanteKg`, costo $0 | ✅ Pass (cobertura existente) | `peps.test.ts:104` |
| 6.5 | Ledger: generación, consumo, reversa_consumo, reversa_generacion, ajuste_incremento, ajuste_decremento | ✅ Pass (cobertura existente) | `peps.test.ts` (generación/consumo/reversa_consumo), `cierreEngine.test.ts` (reversa_generacion vía revertirCierre), `correcciones.test.ts` (ajuste_incremento/ajuste_decremento vía actualizarEntrada) |
| 6.6 | Reconciliación: `kgRestante` = neto del ledger, nunca negativo | ✅ Pass (cobertura existente) | `peps.test.ts:181` "reconciliación: generacion - consumo + reversa_consumo == kgRestante" |

## 7. Cierre de turno

**Ejecutado en vivo de punta a punta — primer cierre de turno REAL y completo logrado en este proyecto** (todas las verificaciones anteriores del proyecto habían quedado bloqueadas por falta de inventario real). `cierreTurnoId jx7cy7hd...`, Línea 1 · Turno 2 · `uat-operador`, 2 cargas.

| # | Caso | Resultado | Evidencia |
|---|---|---|---|
| 7.1 | Fecha operativa server-side (turno 2 cruzando medianoche, 02:00 = día anterior) | ✅ Pass (cobertura existente + en vivo) | `lib/fechaOperativa.test.ts`; en vivo: cierre capturado a las 21:41 hora del navegador quedó con `fecha:"2026-08-09"` (fecha operativa real, no UTC) |
| 7.2 | Estado de los 4 cierres del día (L1/T1, L1/T2, L2/T1, L2/T2) | ✅ | En vivo: las 4 combinaciones mostraban "Pendiente"; tras cerrar, L1·T2 cambió a "✓ Cerrado" en tiempo real en el menú |
| 7.3 | Consumo esperado desde fórmula | ✅ | En vivo: 2 cargas → 50/0/100/15/100/5/3 kg exactos (2× la fórmula por material), recalculado en vivo al cambiar "Cargas preparadas" de 14 a 2 |
| 7.4 | Cierre normal (completo, sin bloqueo) | ✅ | En vivo — "✓ TURNO CERRADO" |
| 7.5 | Cálculos: `kgBuenos`, `mermaTotalKg`, `caballetesKg`, `trituradoKg`, `costoTotalConsumido`, `costoRealPorKg`, `costoRealPorMetro` | ✅ | En vivo, verificado con `npx convex data cierresTurno`: `kgBuenos=2020` (505m×4kg/m ✓), `costoTotalConsumido=$3,096` (suma exacta de las 6 capas consumidas: 195+240+690+126+1120+725 ✓), `costoRealPorKg=1.5327` (3096/2020 ✓), `costoRealPorMetro=6.13` (1.5327×4 ✓) |
| 7.6 | Capa de Triturado a $0 | ✅ Pass (cobertura existente + en vivo) | En este cierre `trituradoKg:0` (merma=0, no generó capa nueva) — pero el material Triturado SÍ se consumió como insumo de fórmula (25kg) sin capa disponible, resultando en `faltanteKg:25` sin error — confirma en vivo la excepción de Triturado (6.4) en un flujo real, no solo el test unitario |
| 7.7 | Validaciones: cargas/metros/caballetes/consumo negativos | ✅ Pass (cobertura existente) | `cierreEngine.test.ts`, además `ConvexError` verificado en `erroresNegocio.test.ts` (EDS-73) |
| 7.8 | Validación: inventario insuficiente | ✅ Pass (cobertura existente + en vivo 2 veces) | Ver 6.3 — mismo hallazgo/fix de EDS-73 |
| 7.9 | UI: advertencias, confirmación, sin `alert()` nativo, banners inline | ✅ | En vivo: advertencia real de "cargas fuera de lo normal (usualmente 10-20)" con botón "Sí, es correcto" (banner inline, no encontrado documentado antes en el plan de pruebas del usuario — hallazgo positivo) |
| 7.10 | Existencia real derivada tras el cierre | ✅ | Verificado con `npx convex data capasCosto`: las 6 capas consumidas decrementaron exactamente lo esperado (ej. 500→497 en Aditivo UV por 3kg consumidos), ninguna negativa |

## 8. Recierre duplicado

**Ejecutado en vivo — mismo `cierreTurnoId`, recerrado con valores distintos (3 cargas en vez de 2).**

| # | Caso | Resultado | Evidencia |
|---|---|---|---|
| 8.1 | Cerrar la misma combinación fecha/línea/turno otra vez | ✅ | En vivo: banner "⚠ Línea 1 · Turno 2 ya se cerró hoy. Puedes continuar, pero se registrará como una corrección (recierre)." al entrar de nuevo |
| 8.2 | Primer intento devuelve advertencia (no escribe nada) | ✅ | En vivo: segunda advertencia explícita antes del submit final — "Guardar de nuevo se registrará como una corrección (recierre), revirtiendo el consumo anterior y aplicando estos valores nuevos", con botón "Sí, recerrar este turno" (doble confirmación, no solo una) |
| 8.3 | Confirmar recierre | ✅ | En vivo — "✓ Turno cerrado" |
| 8.4 | Un solo `cierresTurno` vigente | ✅ | Verificado con `npx convex data cierresTurno` — mismo `_id` (`jx7cy7hd...`), un solo documento, ahora con `cargasPreparadas:3` |
| 8.5 | `vecesRecapturado` +1 | ✅ | `vecesRecapturado: 1` (era 0) |
| 8.6 | Consumos anteriores `vigente:false` | ✅ | 7 filas viejas (2 cargas) confirmadas `vigente:false` |
| 8.7 | Consumos nuevos `vigente:true` | ✅ | 7 filas nuevas (3 cargas) confirmadas `vigente:true` |
| 8.8 | Inventario revertido y reaplicado — **sin doble descuento** | ✅ **(el criterio más crítico del proyecto, confirmado con números reales)** | `capasCosto` refleja EXACTAMENTE el consumo del recierre (3 cargas) sobre la base original de 500kg — ej. Carbonato: 500−150=350kg, no 500−100−150=250kg. Verificado material por material, los 7 cuadran exacto |
| 8.9 | `correccionesHistorial` con motivo `recierre_duplicado` | ✅ | Fila real con `snapshotAntes` (`cargasPreparadas:2, costoTotalConsumido:3096, vecesRecapturado:0`) y `snapshotDespues` (`cargasPreparadas:3, costoTotalConsumido:4644, vecesRecapturado:1`) — auditoría completa, legible, con `corregidoPor` = uat-operador |
| 8.10 | No doble descuento PEPS | ✅ | Ver 8.8 |

## 9. Corrección de capturas

| # | Caso | Resultado | Evidencia |
|---|---|---|---|
| 9.1 | Listado últimos 10 días por fecha operativa | ✅ Pass (cobertura existente) | `correcciones.test.ts` |
| 9.2 | Editar cierre (vía `actualizarCierreTurno`, admin) | ✅ Pass (motor compartido ya demostrado en vivo) | `actualizarCierreTurno` usa `recapturarCierreImpl` — el MISMO motor ya ejecutado en vivo y verificado en la Sección 8 (revertir→aplicar→patch→auditoría). `correcciones.test.ts` cubre el caso específico de acceso admin-only |
| 9.3 | Editar entrada pendiente | ✅ Pass (cobertura existente) | `correcciones.test.ts` |
| 9.4 | Editar entrada costeada | ✅ Pass (cobertura existente) | `correcciones.test.ts` |
| 9.5 | Bloquear reducción si `nuevoKg < kgYaConsumido` | ✅ Pass (cobertura existente + `ConvexError` verificado) | `correcciones.test.ts`; también uno de los 11 tests de `erroresNegocio.test.ts` (EDS-73) — mensaje real: "No se puede reducir a Xkg: ya se consumieron Ykg..." |
| 9.6 | Ajuste incremento/decremento | ✅ Pass (cobertura existente) | `correcciones.test.ts` — `capaMovimientos` tipo `ajuste_incremento`/`ajuste_decremento` |
| 9.7 | Historial: snapshot antes/después, usuario, nota, fecha | ✅ Pass (cobertura existente + en vivo) | Confirmado en vivo en la Sección 8 con datos reales, no simulados — snapshot legible completo con `corregidoPor`/`corregidoEn` |
| 9.8 | Caso límite: no revertir cierre si el Triturado generado ya fue consumido por un cierre posterior | ✅ Pass (cobertura existente) | `cierreEngine.test.ts` (parcial y total), además `EDS-71` endureció la selección de la capa viva por ausencia de `reversa_generacion` en el ledger, no por timestamp |

---

## Limpieza y evidencia final (secciones 1–9)

**Datos generados durante la corrida:** 5 usuarios de prueba (`uat-admin`, `uat-operador`, `uat-compras`, `uat-calidad`, `uat-gerencia`), 7 capas de inventario sembrado directo (`origen:"inventarioInicial"`, 500kg c/u), 1 `cierresTurno` real (Línea 1 · Turno 2, recerrado una vez), sus `cierreConsumos`/`capaMovimientos`, y 1 fila de `correccionesHistorial`.

**Limpieza:** función temporal `_uatSeedTempImpl.borrarUAT` — acotada por los 5 IDs de usuario UAT (no un vaciado ciego de tablas), borra en cascada: sesiones, `loginIntentos`, `cierresTurno` capturados por un usuario UAT, sus `cierreConsumos`, `correccionesHistorial` con `corregidoPor` UAT, `capaMovimientos` con `createdBy` UAT y las `capasCosto` que solo tenían movimientos UAT, y por último los 5 usuarios. Resultado: `{ cierresBorrados: 1, capasBorradas: 7, correccionesBorradas: 1 }`.

**Verificación post-limpieza (`npx convex data` por tabla):** `users` — solo `edson` (real). `sessions` — solo 4 sesiones reales preexistentes de `edson`. `loginIntentos`, `capasCosto`, `cierresTurno`, `cierreConsumos`, `capaMovimientos`, `correccionesHistorial` — las 6 completamente vacías. Archivos temporales (`_uatSeedTemp.ts`, `_uatSeedTempImpl.ts`) borrados del repo y resincronizados con `npx convex dev --once`. Servidor local de prueba detenido.

**Hallazgos de esta corrida (secciones 1–9):**
1. **EDS-41 (inventario inicial) confirmado que nunca se construyó** — no bloqueante para el resto de las pruebas (se sembró directo para poder continuar), pero es un prerrequisito real pendiente antes de operación real.
2. **Buena UX no documentada previamente**: advertencia de "cargas fuera de lo normal (usualmente 10-20 por turno)" y doble confirmación explícita en un recierre ("revirtiendo el consumo anterior y aplicando estos valores nuevos") — ambas con banners inline, sin `alert()` nativo.
3. **Ningún hallazgo bloqueante ni mayor nuevo** — todo lo ejecutado en vivo coincidió exactamente con lo esperado, incluyendo el criterio más crítico del proyecto (recierre sin doble descuento PEPS), confirmado con números reales por primera vez de punta a punta en este proyecto.

## 10–19. Pendiente — próxima pasada

Panel de Control, Alertas, Reporte Diario, Gestión de Usuarios (flujos no cubiertos por Sección 2), Seguridad y errores (más allá de lo ya cubierto en Sección 2/EDS-73), Estados de UI (loading/empty/error, responsive), Exportaciones e impresión, Pruebas de integridad final consolidadas. Decisión explícita del usuario: núcleo crítico de integridad de datos (1–9) primero, resto en una siguiente sesión.
