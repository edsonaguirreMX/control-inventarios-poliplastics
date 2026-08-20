# Documentación Funcional Completa — Sistema Tejaflex (Control de Materias Primas)

**Propósito de este documento:** describir con precisión TODO lo que hace la plataforma actual — módulos, reglas de negocio, patrones técnicos reutilizables — como referencia para diseñar sistemas similares desde cero. No es una guía de usuario ni un changelog; es un mapa funcional completo del sistema tal como quedó implementado.

**Stack:** Backend en **Convex** (base de datos + funciones serverless + cron jobs, TypeScript), frontend en **Express** sirviendo HTML multipágina (sin framework SPA), autenticación casera (bcrypt + sesiones propias, sin proveedor externo).

---

## Índice

1. [Arquitectura y patrones técnicos reutilizables](#1-arquitectura-y-patrones-técnicos-reutilizables)
2. [Autenticación y seguridad](#2-autenticación-y-seguridad)
3. [Sistema de roles dinámico](#3-sistema-de-roles-dinámico)
4. [Gestión de usuarios](#4-gestión-de-usuarios)
5. [Catálogo de materiales](#5-catálogo-de-materiales)
6. [Parámetros de producción y fórmula de receta](#6-parámetros-de-producción-y-fórmula-de-receta)
7. [Punto de reorden](#7-punto-de-reorden)
8. [Motor de costeo PEPS/FIFO](#8-motor-de-costeo-pepsfifo)
9. [Entradas con costeo](#9-entradas-con-costeo)
10. [Cierre de turno](#10-cierre-de-turno)
11. [Corrección de capturas](#11-corrección-de-capturas)
12. [Ajustes de inventario](#12-ajustes-de-inventario)
13. [Panel de Control / KPIs](#13-panel-de-control--kpis)
14. [Sistema de alertas](#14-sistema-de-alertas)
15. [Reporte Diario — envío real y PDF adjunto](#15-reporte-diario--envío-real-y-pdf-adjunto)
16. [Reporte Directivo (PDF ejecutivo)](#16-reporte-directivo-pdf-ejecutivo)
17. [Importación de inventario inicial](#17-importación-de-inventario-inicial)
18. [Exportación de datos (CSV/Excel y PDF)](#18-exportación-de-datos-csvexcel-y-pdf)
19. [Diseño responsivo / mobile-first](#19-diseño-responsivo--mobile-first)
20. [Convenciones de interfaz (UI/UX)](#20-convenciones-de-interfaz-uiux)
21. [Bootstrap de un deployment nuevo (seed)](#21-bootstrap-de-un-deployment-nuevo-seed)
22. [Infraestructura y despliegue](#22-infraestructura-y-despliegue)
23. [Estrategia de pruebas](#23-estrategia-de-pruebas)
24. [Mapa de pantallas](#24-mapa-de-pantallas)
25. [Reglas de negocio invariantes (nunca deben romperse)](#25-reglas-de-negocio-invariantes-nunca-deben-romperse)
26. [Glosario](#26-glosario)

---

## 1. Arquitectura y patrones técnicos reutilizables

Estos patrones no son específicos de este negocio — son decisiones de diseño reutilizables para cualquier sistema similar (captura operativa + costeo + reportes + notificaciones).

### 1.1 Patrón `*Impl` + wrapper delgado
La lógica de cada operación vive en una función plana (`xImpl(ctx, args)`) que no es una función de Convex registrada — es reutilizable desde cualquier contexto (una `query`, una `mutation`, otra función `*Impl`, o un job de servidor). La función de Convex que sí se expone (`query`/`mutation`/`internalQuery`) es un wrapper delgado que solo valida permisos y delega. Esto permite:
- Componer varias operaciones dentro de una sola transacción.
- Reutilizar la misma lógica desde un botón de UI y desde un cron/job interno, sin duplicar código ni pasar por HTTP.
- Testear la lógica de negocio sin pasar por la capa de autorización.

### 1.2 Mutations atómicas de batch
Cualquier pantalla con una tabla editable (Catálogo, Parámetros, Roles, Usuarios, Alertas) usa **una sola mutation** que recibe todas las filas modificadas de una vez ("Guardar cambios"), nunca un loop de mutations independientes del cliente fila por fila. Evita que un fallo a la mitad deje datos inconsistentes, y evita también N round-trips de red.

### 1.3 "Nada se sobrescribe" — ledger inmutable + soft-delete
Regla de diseño transversal a todo el sistema:
- **Movimientos de inventario** (`capaMovimientos`): cada evento se inserta como fila nueva, nunca se edita ni se borra una existente. Para revertir algo, se agrega un movimiento contrario (`reversa_consumo`, `reversa_generacion`) que anula el efecto neto pero deja rastro de que existió.
- **Correcciones administrativas**: el registro original se marca `editado:true`/`vigente:false`, y se inserta un snapshot completo de "antes" y "después" en una tabla de historial aparte — nunca se pisa el dato en su lugar.
- **Entidades de catálogo** (materiales, roles, usuarios): "eliminar" siempre es un soft-delete (`activo:false`), nunca un borrado físico, porque otras tablas los referencian para auditoría histórica.

Esta regla resuelve un problema recurrente en sistemas de costeo/inventario: sin ella, es imposible reconstruir "qué pasó realmente" después de una corrección, y los reportes históricos dejan de ser confiables.

### 1.4 "Día operativo" — nunca confiar en la medianoche del calendario
Cuando la operación física cruza medianoche (turnos nocturnos), la fecha operativa de un registro no es la fecha calendario del reloj en el momento de capturarlo — es la fecha del turno al que pertenece. Todo lo capturado entre las 00:00 y la hora de inicio del primer turno del día pertenece operativamente al día anterior. Esto se calcula server-side con una función centralizada (una sola fuente de verdad), nunca con `new Date().toISOString()` directo, porque eso da la fecha en UTC y puede desalinear duplicados, ventanas de corrección y reportes según el huso horario real de la operación.

### 1.5 Validación server-side siempre, nunca solo en el cliente
Cada función sensible valida su propia autorización y sus propios rangos de fecha/valores en el servidor — la UI puede ocultar un botón o restringir un date-picker, pero eso nunca es la única defensa, porque alguien podría llamar la API directo.

### 1.6 Doble validación por capas (defensa en profundidad)
Ejemplo del sistema de notificaciones: la normalización/validación de un correo o teléfono ocurre en la mutation que lo captura, y **otra vez** como segunda capa de defensa justo antes de usarlo (deduplicar antes de enviar), por si algún dato viejo quedó sin normalizar. No es redundancia innecesaria — es asumir que los datos pueden llegar sucios desde múltiples caminos con el tiempo.

### 1.7 Degradación con gracia, nunca fallo total por una pieza opcional
Cuando una funcionalidad "adicional" depende de un servicio externo o de un cálculo que puede fallar (ej. construir un PDF, o enviar por un canal sin credenciales configuradas), el fallo de esa pieza específica se loguea y se aísla — nunca tumba el flujo principal. Ejemplo: si el PDF adjunto de un reporte falla al construirse, el correo se manda igual sin el adjunto; si un canal de notificación no tiene credenciales, ese canal específico queda en error pero los demás destinatarios/canales siguen su curso.

### 1.8 Idempotencia real, no solo "intentar una vez"
Las operaciones que hablan con servicios externos (envío de notificaciones) verifican antes de actuar si esa combinación exacta (referencia + canal + destinatario) ya se completó con éxito, para no duplicar el efecto si la operación se reintenta o se vuelve a invocar. Se combina con encabezados de idempotencia nativos del proveedor externo cuando existen (ej. `Idempotency-Key` de Resend).

---

## 2. Autenticación y seguridad

- **Login**: usuario/contraseña. Contraseña con hash **bcrypt** (nunca en claro). Mensaje de error genérico e idéntico sin importar si el usuario no existe, está inactivo, o la contraseña es incorrecta (no da pistas a un atacante).
- **Sesiones**: token aleatorio, dos duraciones según si el usuario marca "recordar en este dispositivo" — 30 días (persistente, `localStorage`) vs. ~12 horas (se pierde al cerrar pestaña, `sessionStorage`).
- **Rate limiting de fuerza bruta**: 5 intentos fallidos por `usuario` en 15 minutos → bloqueo de 15 minutos, con ventana deslizante (si el intento más viejo ya expiró, el conteo se reinicia). El chequeo "¿está bloqueado?" + "registrar el intento" es una sola operación atómica, para que ráfagas simultáneas no se cuelen antes de que el contador se actualice.
- **Logout automático por inactividad**: 10 minutos sin interacción (mouse/teclado/scroll/touch/click) cierran la sesión del lado del cliente, revisando cada 15 segundos (no en cada evento, para no sobrecargar).
- **Autorización en 2 capas** (ver sección 3): un mecanismo dinámico basado en roles editables, y un mecanismo fijo hardcodeado reservado exclusivamente para las 2 pantallas que administran el propio control de acceso (evita que el sistema dinámico pueda auto-otorgarse control de sí mismo).
- **Nunca se expone `passwordHash`** ni tokens/secretos a través de ninguna query — se validan server-side y no se retornan al cliente.
- **Secretos de proveedores externos** (API keys de Resend/Twilio) viven como variables de entorno del deployment del backend, nunca en el código ni en el repo — se leen server-side dentro de las funciones que los necesitan, con mensajes de error explícitos y accionables si faltan.

---

## 3. Sistema de roles dinámico

A diferencia de un enum fijo de roles en código, **los roles son documentos en base de datos**, editables desde una pantalla admin-only, sin requerir un despliegue de código para crear un rol nuevo o cambiar a qué pantallas tiene acceso.

**Cada rol tiene:**
- `slug` — identificador estable (generado del nombre al crear el rol, nunca cambia aunque se renombre el rol después — es lo que queda referenciado en `users.rol`).
- `nombre` — nombre visible, editable.
- `paginas` — lista de páginas del catálogo fijo a las que da acceso.
- `vistasPanel` — lista de sub-vistas internas del dashboard a las que da acceso (independiente de `paginas`).
- `protegido` — no se puede editar/desactivar/eliminar desde la UI de gestión.
- `bypassAcceso` — pasa cualquier verificación de acceso sin importar qué tenga en `paginas`/`vistasPanel`.
- `activo`, `orden`, `updatedAt`/`updatedBy`.

**Catálogo de páginas**: un conjunto fijo definido en código (no en base de datos) — la mayoría configurables por rol, pero **las pantallas que administran usuarios/roles quedan siempre fuera de lo configurable**, hardcodeadas admin-only. Esto es una regla de seguridad deliberada: un rol personalizable nunca debe poder auto-otorgarse control administrativo del sistema (evita escalación de privilegios).

**Vistas internas de un dashboard compartido**: cuando una sola pantalla (ej. Panel de Control) sirve a varios roles con contenido distinto según su función (compras ve existencias/reorden, calidad ve merma/producción, gerencia ve costos), el acceso a la PÁGINA y el acceso a cada VISTA dentro de ella son dos permisos independientes — un rol puede tener acceso a la página pero cero vistas asignadas (y en ese caso la UI debe mostrar un estado vacío claro, no una pantalla en blanco).

**`protegido` vs. `bypassAcceso` son conceptos distintos**, aunque coincidan en el rol admin de este sistema: uno es "no editable", el otro es "acceso total". No conviene fusionarlos en un solo booleano — un futuro rol "solo lectura de todo, no editable" necesitaría `protegido:true` sin `bypassAcceso`.

**Mantenimiento (seed idempotente)**: existe una operación de "sembrado/reparación" de roles base que es segura de correr repetidamente en cualquier momento — inserta lo que falte, reactiva roles desactivados accidentalmente, rellena campos nuevos que se hayan agregado al sistema con el tiempo (solo si el campo nunca se tocó, nunca pisa una personalización ya hecha por un admin), y reporta (sin fallar) si algún usuario quedó con un rol que ya no existe.

---

## 4. Gestión de usuarios

Pantalla exclusiva de administradores. Campos: nombre, usuario (login, único, normalizado a minúsculas), contraseña (hash), rol (referencia dinámica), activo/inactivo.

- **Alta**: el admin da nombre/usuario/rol; el sistema genera una **contraseña temporal aleatoria** (evita símbolos ambiguos como 0/O, 1/l) con un generador criptográficamente seguro, mostrada **una sola vez** en pantalla.
- **Edición en lote** (batch atómico), igual que Catálogo/Parámetros/Roles.
- **"Eliminar" = desactivar**, nunca borrado físico (preserva auditoría en tablas que referencian al usuario). Reversible.
- **Reset de contraseña**: nueva contraseña temporal + invalida todas las sesiones activas de ese usuario.
- **Invariante crítico: siempre debe quedar al menos un usuario activo con un rol protegido/admin.** Se valida después de cualquier edición (individual o batch) — cubre el caso de que un admin se reasigne a sí mismo (o a otros) a un rol no-admin sin desactivarse. Un admin tampoco puede desactivarse a sí mismo con su propia sesión abierta. Sin esta doble protección, el sistema podría quedar sin nadie capaz de administrarlo.
- Un usuario no puede asignarse un rol inexistente o inactivo.

---

## 5. Catálogo de materiales

Maestro único de materias primas — todo lo demás (fórmula, entradas, cierres, costeo, punto de reorden) referencia este catálogo, nunca lo duplica.

**Campos por material:**
| Campo | Qué representa |
|---|---|
| `nombre`/`variante` | identidad del material |
| `esInterno` | marca materiales generados internamente (ej. merma reciclada) — no se compran, no tienen punto de reorden |
| `esSustituto` | marca materiales de reemplazo eventual — tampoco tienen punto de reorden (no se planifican como insumo regular) |
| `costoEstandar` | costo de referencia (no es el costo real de compra, ese vive en las capas PEPS) |
| `leadTimeDias` / `stockSeguridadDias` | parámetros logísticos por material, usados en la fórmula de reorden; pueden faltar (`null`) si no se han capturado aún |
| `reorderMode` (`auto`\|`manual`) + `reorderManualKg` | permite fijar el punto de reorden a mano en vez de calcularlo |
| `cantidadPedirKg` | cantidad sugerida a pedir |
| `activo`/`orden` | soft-delete + orden de despliegue |

**Todo lo derivado se calcula en vivo, nunca se guarda** (para que dos pantallas nunca puedan divergir): % de mezcla, consumo diario teórico, punto de reorden calculado, y cuál de los dos (calculado o manual) está "en uso".

**Regla de negocio no negociable**: un material marcado como la merma reciclada del propio proceso siempre cuesta **$0** — ni un administrador puede editar ese costo a otro valor. Evita duplicar el costo de la merma (que ya se absorbió en el costo del producto bueno el día que se generó).

Guardado en lote atómico para toda la tabla a la vez.

---

## 6. Parámetros de producción y fórmula de receta

Centraliza las reglas operativas de la planta y la receta estándar, para que ninguna otra pantalla tenga que adivinar o duplicar estos valores.

**Parámetros globales (singleton):** cargas por turno, turnos por día, líneas activas, factor de conversión kg↔metro de producto, hora de inicio de cada turno (determina el "día operativo", ver 1.4), días laborales de la semana, minutos de gracia antes de considerar un turno como "sin cerrar", zona horaria explícita.

**Fórmula de receta** (una fila por material): cuántos kg de ese material entran en una carga estándar, más nota libre. Regla dura: la suma de kg de todos los materiales activos de la fórmula nunca puede quedar en cero (colapsaría todos los cálculos derivados de golpe) — esta verificación corre al final de la transacción completa, no fila por fila (un guardado legítimo puede pasar por un total intermedio de 0 mientras se editan varias filas).

Guardado en lote atómico (parámetros globales + fórmula completa a la vez).

---

## 7. Punto de reorden

Fórmula única, compartida por Catálogo y por el Panel de Control (antes existían dos cálculos ligeramente distintos y se unificaron para que nunca puedan divergir):

```
consumoDiarioTeórico = kgPorCarga(material) × cargasPorTurno × turnosPorDía × líneasActivas
puntoDeReorden = consumoDiarioTeórico × (leadTimeDías + stockSeguridadDías)
```

Es deliberadamente **teórico** (basado en receta y volumen planeado), no en consumo histórico real — así el sistema anticipa necesidad de compra antes de quedarse sin material, en vez de reaccionar tarde con base en promedios pasados. `leadTimeDías` ausente se asume 0; `stockSeguridadDías` ausente asume un default razonable (7 días en este sistema).

Estado semafórico por material (usado en Catálogo y Panel de Control): **crítico** (existencia por debajo del punto de reorden), **por vencer/alerta** (cerca de tocarlo), **ok**.

---

## 8. Motor de costeo PEPS/FIFO

Garantiza que el costo de cada kg consumido sea trazable y auditable — el inventario se valúa por capas, y el consumo siempre toma primero la capa más antigua (Primeras Entradas, Primeras Salidas).

**Capas de costo**: cada "lote" de material valuado guarda cantidad original, cantidad restante (caché derivado, reconciliable), costo unitario, fecha de entrada (determina el orden FIFO — la fecha REAL del evento físico, no cuándo se tecleó en el sistema), origen (compra costeada / merma reciclada siempre a $0 / inventario inicial / ajuste manual), y si ya se agotó.

**Consumo FIFO**: toma las capas no agotadas ordenadas por fecha de entrada ascendente, descuenta de la más vieja, y si no alcanza **cruza a la siguiente** hasta cubrir el total, sumando el costo proporcional de cada capa tocada.

**Bloqueo por inventario insuficiente**: si no hay existencia suficiente, la operación se detiene con un error de negocio explícito — el sistema nunca deja pasar un consumo sin respaldo real de inventario. **Única excepción**: el material generado internamente (merma reciclada) sí puede reportar un faltante en el consumo de producción normal, porque generar menos de lo esperado es una realidad física normal de la operación (y como su costo es $0, no hay riesgo de subcosteo) — pero esta excepción **no aplica** a ajustes manuales de inventario (ver sección 12), donde cualquier faltante solo puede ser un error de captura.

**Ledger inmutable de movimientos**: cada evento sobre una capa (generación, consumo, reversa de cada uno, ajuste manual) se inserta como fila nueva — nunca se edita ni borra una existente. Revertir algo significa agregar un movimiento contrario que anula el efecto neto pero deja rastro histórico completo. Cada movimiento guarda quién lo generó y su origen (entrada / cierre de turno / corrección / inventario inicial / ajuste manual) para trazabilidad completa de causa-efecto.

**Consultas de inventario separadas por sensibilidad**: existencia en kg (accesible a más roles) vs. valor monetario del inventario (dato financiero, restringido a roles con visibilidad de costos).

---

## 9. Entradas con costeo

Separa deliberadamente la **captura física** de material recibido (la hace quien recibe, sin visibilidad de costos) del **costeo real** de esa compra (lo hace Compras/Admin con la factura en mano) — un operador de recepción nunca puede inventar o alterar el costo de una capa de inventario.

**Flujo de dos pasos:**
1. **Registro**: fecha real de recepción, material, kg — sin costo. Queda `pendiente`.
2. **Costeo**: se completa costo unitario, proveedor, folio. Solo en este momento se genera la capa de costo PEPS — sin costo no hay capa que crear. Pasa a `costeada`.

**Reglas**: cantidad > 0, costo ≥ 0. El material generado internamente (merma reciclada) **no puede** recibir entradas de compra (no se compra, se genera solo). La fecha no puede ser futura, pero **no tiene límite hacia atrás** (es normal registrar tarde el papeleo de un recibo viejo — a diferencia de un cierre de turno). Una entrada ya costeada no se vuelve a costear (para eso existe Corrección de Capturas). Solo se puede eliminar mientras siga `pendiente` sin capa asociada — una vez costeada, se corrige, no se borra (dejaría una capa huérfana). Registro en lote atómico.

---

## 10. Cierre de turno

El evento operativo central: al final de cada turno, quien opera reporta qué se produjo y con qué se consumió, y el sistema deriva automáticamente merma, consumo real de inventario (vía PEPS) y costo real.

**Captura**: fecha, línea, turno, cargas preparadas, metros de producto bueno, piezas de dos tipos de subproducto reutilizable (a partir de merma), y consumo real por material (el sistema propone un valor esperado según fórmula × cargas, la persona confirma/ajusta).

**Cálculos derivados:**
- `kgBuenos = metrosBuenos × kgPorMetro`
- `mermaTotal = max(0, totalConsumido − kgBuenos)`
- Parte de la merma se convierte en subproducto reutilizable (piezas × peso fijo por pieza, acotado a no exceder la merma real); el resto se convierte en material reciclado interno.
- El consumo real de cada material se descuenta del inventario vía FIFO (esto es lo que efectivamente mueve el costo).
- **El material reciclado generado se reintegra a inventario como una nueva capa a $0** (consistente con la regla de Catálogo).
- `costoRealPorKg = costoTotalConsumido / kgBuenos`; `costoRealPorMetro = costoRealPorKg × kgPorMetro`.

**Ventana de fecha (días hacia atrás)**: acepta capturar un turno con cierto margen retroactivo razonable (para ponerse al día tras un fin de semana o falla de conectividad), validado siempre en servidor. Pasado ese margen, el camino correcto es Corrección de Capturas (con su propia ventana, más amplia, y auditoría explícita) — no forzar el cierre normal.

**Recierre de un turno ya cerrado**: nunca crea un segundo registro superpuesto. Pide confirmación explícita, y si se confirma, **revierte por completo** el efecto del cierre anterior (revierte consumos, revierte la capa de material reciclado que generó) antes de volver a aplicar los valores nuevos — evita doble descuento de inventario. Si el material reciclado que un cierre generó ya fue consumido por un cierre posterior, ese cierre original no se puede revertir hasta revertir primero el posterior (mensaje explícito indicando qué hacer).

---

## 11. Corrección de capturas

Permite corregir administrativamente un cierre de turno o una entrada ya guardados, sin perder nunca el rastro de qué cambió, cuándo, quién y por qué.

- **Cierres de turno**: usa literalmente el mismo motor que el "recierre" (revertir → reaplicar → auditar), distinguido solo por el motivo registrado.
- **Entradas**: ajuste de cantidad/proveedor/folio. Si aún no generó capa, es un ajuste simple. Si ya generó capa y parte de esa cantidad ya se consumió, el saldo nuevo es **determinístico** (cantidad nueva − ya consumido), nunca proporcional, y se bloquea si la cantidad nueva sería menor a lo ya consumido (habría que revertir esos consumos primero).

**Mecanismo central**: el registro afectado se marca como editado/no-vigente, y se inserta una fila nueva en un historial de correcciones con snapshot completo de "antes" y "después" (más motivo y nota libre) — nunca se pisa el dato en su lugar. Existe corrección en lote para varios renglones del mismo día.

---

## 12. Ajustes de inventario

Cubre movimientos que no encajan en el flujo normal de compra (Entradas) ni de producción (Cierre de Turno) — muestras recibidas informalmente, diferencias de conteo físico.

- **Admin-only.**
- Dos tipos: entrada manual (crea capa nueva) y salida manual (consume FIFO).
- A diferencia de Entradas de compra, aquí **sí se permite ajustar el material reciclado interno** — es exactamente el caso de uso ("el conteo físico de merma reciclada no cuadra").
- **Las salidas manuales SIEMPRE bloquean si no hay existencia suficiente, sin excepción** (a diferencia del consumo de producción, que sí tolera un faltante del material reciclado por ser una realidad física normal) — en un ajuste manual no existe ninguna justificación física para un faltante, solo puede ser un error de captura. Esta es una capa de validación adicional específica de este módulo, no un cambio al motor FIFO general.
- La fecha **nunca** se recibe del cliente ni se retrofecha — siempre es la fecha operativa real del momento del ajuste.
- Motivo de texto obligatorio (auditoría). Nada se edita ni revierte una vez guardado — un ajuste mal capturado se corrige con un ajuste contrario, nunca editando el original.

---

## 13. Panel de Control / KPIs

**KPIs del día** (en realidad, del **último cierre real capturado**, nunca de "hoy" — en la operación real un turno se cierra horas o días después de ocurrir, así que "hoy" casi nunca tiene datos):
- Por material: existencia, valor, punto de reorden en uso, cobertura en días, estatus semafórico.
- Globales: valor total de inventario, % de merma, producción (kg/metros), costo real vs. estándar por kg y por metro.

**Tendencias con selector de periodo** (último cierre / 7 / 14 / 30 días, o promedio de los últimos N cierres reales en vez de días naturales — para no diluirse con días sin captura): producción por línea/turno, evolución de % de merma, evolución de costo real por kg, agregados de todo un rango.

**Objetivos de producción**: metas configurables por turno/línea, semana y mes — cualquier rol con acceso al panel las puede consultar, pero editarlas queda restringido a admin como excepción deliberada dentro de una pantalla que varios roles comparten.

**Vistas segmentadas por rol** dentro de una misma pantalla (ver sección 3): compras ve existencias/reorden, calidad ve merma/producción, gerencia ve costos — la misma data real, presentada distinto según a quién le interesa qué.

---

## 14. Sistema de alertas

**7 reglas configurables**, cada una con: nombre, descripción, umbral numérico ajustable, roles destinatarios, canales (correo / WhatsApp / notificación in-app — cualquier combinación), y activa/inactiva:

1. **Turno sin cerrar** — pasado un margen de gracia tras la hora de fin teórica del turno.
2. **Material en punto de reorden crítico** — existencia por debajo del punto de reorden.
3. **Material por vencer su punto de reorden** — cerca de volverse crítico (no se dispara si ya disparó la crítica el mismo material el mismo día).
4. **% de merma por arriba de la meta** — con margen de tolerancia configurable.
5. **Producción por debajo del objetivo** — acumulado de la semana vs. objetivo semanal.
6. **Costo real por arriba del estándar** — con margen de tolerancia configurable.
7. **Entrada pendiente de costeo** — lleva más de N días sin costo capturado (desactivada por defecto).

**Evaluación**: un cron periódico (cada ~20 min) reevalúa las 7 reglas contra los datos reales, reutilizando el mismo cálculo de KPIs del Panel de Control (nunca duplica lógica).

**Dedupe por día operativo**: cada alerta disparada genera una clave única (regla + entidad + fecha de referencia) para que, aunque el cron corra muchas veces el mismo día, la misma alerta no se repita — solo una vez por regla+entidad+día. Para reglas basadas en el último cierre, la fecha de dedupe es la del cierre de referencia, no el día calendario del cron — así no genera ruido diario repetido por el mismo evento viejo si pasan varios días sin un cierre nuevo.

**Notificación in-app ("campana")**: historial global de alertas disparadas, con lectura marcada **por usuario** (no global) — una alerta leída por uno sigue apareciendo como no leída para otro.

**Nota de diseño importante**: en este sistema, las reglas de alertas se configuran por **rol destinatario** (`destinatariosRoles`), no por contacto individual — para poder enviar de verdad por correo/WhatsApp hace falta resolver "rol → personas con ese rol → su correo/teléfono", lo cual requiere que la tabla de usuarios tenga esos datos de contacto capturados (en este sistema, ese paso quedó identificado como trabajo futuro separado, ver sección 15 para el canal que sí se conectó primero).

---

## 15. Reporte Diario — envío real y PDF adjunto

Un reporte automático (o disparable manualmente con un botón) que se genera a una hora configurable cada día y se envía por correo y/o WhatsApp a una lista de destinatarios capturada directamente (a diferencia de Alertas, aquí los destinatarios son contactos reales, no roles).

### 15.1 Generación y envío
- **Botón manual** ("Generar ahora") y **cron diario** a la hora configurada — ambos comparten el mismo motor de envío, se distinguen solo por quién lo disparó (persona vs. automático), y el cron nunca duplica: valida que no exista ya un envío automático ese mismo día operativo antes de generar otro.
- Al generar, dispara en paralelo: una notificación in-app (campana) + el envío real por correo y WhatsApp a los destinatarios configurados.
- El envío real ocurre en una función de servidor separada de la que registra el evento (una mutation no puede hacer llamadas HTTP salientes; se agenda una función aparte para ejecutarse justo después).

### 15.2 Envío por correo (proveedor externo tipo Resend)
- Llamada HTTP directa a la API REST del proveedor (sin SDK del proveedor, para no depender del runtime de Node — el runtime estándar de funciones serverless ya trae `fetch` nativo).
- **Reintento único** si la respuesta es un error de servidor (5xx) o un error de red — nunca reintenta un error 4xx (un destinatario inválido no se arregla reintentando).
- **Idempotencia**: header de idempotencia nativo del proveedor con una clave determinística (referencia del envío + canal + destinatario), más una verificación previa contra el propio historial de envíos — si esa combinación exacta ya quedó registrada como exitosa, se salta sin reenviar.
- Un correo por destinatario (no un solo envío a una lista), para poder registrar éxito/error individual por persona.

### 15.3 Envío por WhatsApp (proveedor externo tipo Twilio)
- Mismo patrón de llamada HTTP directa + reintento en 5xx/red.
- **Modo sandbox de pruebas**: requiere que cada destinatario mande manualmente un código de "unión" al número de pruebas antes de poder recibir mensajes — el opt-in caduca cada cierto número de días.
- **Producción real**: un mensaje que el sistema inicia proactivamente (sin que el destinatario haya escrito primero) fuera de una ventana de conversación activa requiere un **Message Template pre-aprobado** por el proveedor de la plataforma de mensajería — no puede ser texto libre arbitrario. Esto es una regla de la plataforma de mensajería, no del proveedor técnico, y aplica sin importar qué proveedor técnico se use.
- El código soporta ambos modos: texto libre (sandbox) o plantilla con variables (producción), seleccionando automáticamente según si hay una plantilla configurada.

### 15.4 Normalización y validación de contactos
- Correos: recorte de espacios + minúsculas.
- Teléfonos: recorte + limpieza de espacios/guiones/paréntesis a formato internacional estándar, validado con una expresión regular (longitud y prefijo de país).
- Deduplicación antes de guardar y **otra vez** antes de enviar (segunda capa de defensa).

### 15.5 Historial y trazabilidad
- Un registro por generación (manual o automática) con: fecha, estado (generado/error), cuántos destinatarios había configurados, quién/qué lo disparó.
- Un log aparte con **una fila por intento de envío individual** (canal, destinatario, éxito/error, detalle del error si aplica, número de intentos, ID del proveedor externo para trazabilidad, fecha) — permite auditar exactamente qué pasó con cada destinatario en cada corrida, no solo un conteo agregado.
- Los conteos de éxito/error del registro principal reflejan **únicamente** si el envío en sí llegó al proveedor — un problema al construir el adjunto opcional (ver 15.6) nunca se mezcla con ese conteo.

### 15.6 PDF adjunto (solo canal correo)
- El sistema no tiene acceso a un navegador del lado del servidor — cualquier "vista de impresión" existente en el frontend no sirve para generar un adjunto real.
- Se construye un PDF **desde cero, en el servidor**, con una librería de generación de PDF pura (sin dependencias nativas ni necesidad de un navegador headless) — dibuja texto y líneas directamente sobre una página en blanco, replicando el mismo contenido/resumen ejecutivo que ya se calcula para otros reportes (ver sección 16), sin recalcular ningún KPI de negocio (solo reutiliza los cálculos ya existentes y los formatea).
- Se construye **una sola vez por generación** (no una vez por destinatario) y se adjunta a cada correo.
- Codificación del archivo a base64 usando la utilidad nativa que la propia librería de PDF ya trae integrada (sin escribir un encoder manual).
- **Degradación con gracia**: si la construcción del PDF falla por cualquier motivo, se loguea el error y el correo se manda igual sin el adjunto — nunca bloquea el envío completo por esto.
- Nombre de archivo estable, con la fecha real de los datos que contiene (no la fecha en que se generó, si difieren).
- No aplica a WhatsApp en este sistema (adjuntar un archivo por esa vía requeriría hostearlo en una URL pública, evaluado como complejidad innecesaria para el caso de uso).

---

## 16. Reporte Directivo (PDF ejecutivo)

El contenido de referencia que tanto la vista de impresión del navegador como el PDF adjunto por correo replican — un resumen condensado a 1-2 páginas, pensado para leerse rápido:

1. **Tabla comparativa**: Último cierre vs. Última semana — % merma, producción, costo real por kg, costo real por metro.
2. **Línea de inventario**: valor total, número de materias primas, conteo de alertas (críticos / por vencer de un total), material más urgente a reordenar con sus días de cobertura.
3. **Tabla de tendencia**: costo real por kg día a día, últimos 7 días naturales.
4. **Línea de promedio**: costo real por kg y por metro, promedio de los últimos N cierres reales (no días naturales).
5. **Línea de producción acumulada**: semana y mes, cada una vs. su objetivo configurado (con % de cumplimiento si hay objetivo definido).

Todos los números salen de cálculos que YA existen en otro lugar del sistema (Panel de Control) — este reporte no inventa ninguna fórmula nueva, solo selecciona y condensa. Diseñado para ser tolerante a un sistema recién desplegado sin datos todavía (muestra ceros o "—" en vez de fallar).

---

## 17. Importación de inventario inicial

Resuelve el problema de "arrancar en cero" al reemplazar un control manual (ej. una hoja de cálculo) por el sistema — sin esto, el inventario real de la operación quedaría invisible hasta que se agotara y se volviera a comprar todo desde cero.

- Carga las capas de costo iniciales a partir de un **conteo físico real** (kg y costo actual de cada material), no de datos inventados.
- **Un solo instante de corte** para todo el lote (una fecha + hora local, no un campo por fila) — físicamente es un solo conteo de planta en un momento dado, no N conteos independientes. Ese instante se convierte en la fecha de entrada de cada capa nueva, y al ser la más antigua del ledger, el motor PEPS la consume primero (correcto: es el inventario más viejo que existe al arrancar).
- **Ejecutable una sola vez por material** — si ya existe una capa de ese material marcada como "inventario inicial", la operación se rechaza explícitamente (evita duplicar el arranque por error, ej. reenviar el mismo archivo dos veces).
- Válida el formato de fecha/hora de forma estricta ANTES de usarla para calcular el instante — un runtime que "normaliza silenciosamente" una fecha inválida (ej. 30 de febrero) en vez de rechazarla podría dejar capas de arranque con la fecha PEPS incorrecta, en una operación que solo puede correrse una vez.
- Restringida a administrador — toca el costeo real de toda la planta de una sola vez.

---

## 18. Exportación de datos (CSV/Excel y PDF)

Cada tabla relevante del Panel de Control (existencias, producción, tendencia de merma, tendencia de costo) y de Ajustes de Inventario tiene su propio botón de exportación a **CSV** (abre directo en Excel), generado enteramente en el navegador (arma el CSV en memoria, con marca de orden de bytes UTF-8 para que Excel respete acentos/ñ, y dispara la descarga sin pasar por el servidor).

La exportación a **PDF completo** (botón "Exportar PDF" del Panel de Control) usa el mecanismo nativo de impresión del navegador sobre una vista especial "solo impresión" de la misma pantalla — reorganiza el contenido a un layout de una sola columna pensado para papel, oculta controles interactivos (filtros, botones), y reemplaza gráficas por tablas equivalentes (una gráfica no se imprime bien, una tabla con los mismos datos sí). Es un mecanismo distinto y más simple que el PDF adjunto de correo (sección 15.6), que si necesita generarse **sin navegador**, del lado del servidor.

---

## 19. Diseño responsivo / mobile-first

Aunque el sistema se diseñó inicialmente pensando en escritorio, la captura real de operación ocurre desde el piso de planta — por eso todas las pantallas se hicieron utilizables desde un celular, en 3 fases sucesivas de auditoría y corrección, cubriendo primero la más urgente (lo que usa el operador) y luego el resto.

**Fase 1 — Login y wizard de Cierre de Turno (la de uso más frecuente y crítico).**
- Hallazgo raíz real: ninguna de las páginas tenía la estructura HTML completa (faltaban las etiquetas de documento estándar) — el navegador las renderizaba en "modo de compatibilidad" antiguo, lo que anulaba por completo cualquier configuración de viewport para móvil, sin importar qué CSS responsivo se escribiera encima.
- El wizard de captura del operador estaba, además, atrapado dentro de un marco decorativo que simulaba "un teléfono dentro de la pantalla de escritorio" — pensado como mockup visual, pero que en un celular real hacía que el formulario real quedara diminuto dentro de otro teléfono dibujado.

**Fase 2 — Pantallas de back-office (Catálogo, Parámetros, Entradas, Corrección, Alertas, Reporte Diario, Ajustes, Gestión de Usuarios).**
- Patrón de bug recurrente y consistente en las 7 pantallas: la barra de acciones inferior (botones "Guardar"/"Restablecer" + aviso de "cambios sin guardar") no permitía que sus elementos pasaran a una segunda línea en pantallas angostas, causando desbordamiento horizontal en cuanto aparecía el aviso de cambios pendientes junto a los botones.
- Ajustes puntuales adicionales: una tarjeta de KPI en $ con cifras de varios dígitos que no cabía en dos columnas a ancho de celular; un modal que necesitaba el mismo permiso de pasar a segunda línea.

**Fase 3 — Panel de Control (dashboard con gráficas y tablas).**
- Ya tenía buena base técnica (gráficas vectoriales con escalado proporcional, grids que colapsan a columnas en pantallas angostas, tablas con scroll horizontal propio). Único ajuste real: una fila de filtros de "tendencia" con el mismo patrón de desbordamiento de las Fases 1-2.

**Lección técnica reutilizable, válida para cualquier proyecto similar:** el bug más costoso de diagnosticar no siempre es el más visualmente obvio — la falta de estructura HTML básica anuló silenciosamente TODO el trabajo de CSS responsivo hecho encima, hasta que se corrigió esa causa raíz específica. Conviene auditar la estructura del documento antes de asumir que un problema de "no se ve bien en celular" es puramente de CSS.

---

## 20. Convenciones de interfaz (UI/UX)

Reglas transversales aplicadas de forma consistente en las 12 pantallas, útiles como checklist de estilo para cualquier sistema similar:

- **Sin diálogos nativos del navegador** (`alert()`/`confirm()`/`prompt()`) — nunca se usan, porque bloquean cualquier automatización de pruebas y no respetan el lenguaje visual propio del sistema. En su lugar: banners de error/aviso incrustados en la misma pantalla, o confirmaciones que requieren un segundo clic explícito.
- **Sesión siempre visible**: cada pantalla protegida muestra quién la tiene abierta (nombre real + rol, no solo el rol) y ofrece un botón de cerrar sesión — nunca se asume que el usuario "ya sabe" quién es en el sistema.
- **Atribución de autoría**: cualquier acción que modifica un dato importante (un cierre de turno, una corrección) deja constancia visible de quién la hizo y cuándo, no solo en el histórico interno sino en la propia interfaz.
- **Escape de contenido dinámico generado por el usuario** (ej. el nombre de un rol, editable por un admin) antes de insertarlo en el HTML de otras pantallas — cualquier campo de texto libre que un administrador pueda editar y que se muestre en más de una pantalla es una superficie potencial de inyección de código si no se escapa consistentemente.
- **Estados vacíos explícitos y accionables**: cuando algo no tiene contenido que mostrar (un rol sin vistas asignadas, un catálogo recién creado sin materiales, un historial sin envíos todavía), la pantalla muestra un mensaje claro de por qué está vacío y qué hacer al respecto — nunca una tabla o sección en blanco sin explicación.
- **Guardado explícito, nunca automático silencioso**: las pantallas con tablas editables muestran un indicador de "cambios sin guardar" y requieren un clic explícito en "Guardar" — evita que un cambio accidental se persista sin que la persona lo confirme.
- **Navegación de regreso consistente** ("‹ Admin" / breadcrumb) en toda pantalla de configuración, para volver siempre al mismo punto central sin depender del botón "atrás" del navegador.

---

## 21. Bootstrap de un deployment nuevo (seed)

Un sistema recién desplegado (sin datos todavía) necesita un camino controlado y seguro para crear su primer usuario administrador y sus catálogos base, sin dejar una contraseña fija en el código ni permitir que cualquiera con acceso al panel del backend pueda sembrar la base por su cuenta.

- **Protegido por un secreto de un solo uso**: la operación de siembra exige un valor secreto configurado como variable de entorno del propio deployment (nunca en el código ni en el repo) — sin ese secreto configurado, la operación se niega con un mensaje explícito de cómo configurarlo.
- **Genera una contraseña aleatoria de alta entropía para el admin inicial**, mostrada una única vez en la respuesta — no queda guardada en texto plano en ningún lado, ni se puede volver a consultar después (si se pierde, el camino es un reset de contraseña normal, no volver a correr el seed).
- **Comparación del secreto resistente a ataques de temporización** — compara los dos valores con una función que tarda el mismo tiempo sin importar en qué posición difieren, para no filtrar información por cuánto tarda la respuesta.
- **Idempotente**: si ya existen datos base (ej. el catálogo de materiales ya tiene filas), la operación se niega a volver a sembrar — protege contra correrla dos veces por error.
- Siembra junto con el admin: el catálogo de materiales inicial, los parámetros de producción por defecto, las reglas de alerta por defecto, y los roles base del sistema.

---

## 22. Infraestructura y despliegue

- **Backend**: base de datos + funciones serverless + cron jobs en una sola plataforma administrada, sin servidor propio que mantener. El código de funciones se despliega de forma independiente al frontend, y **no se redespliega solo** cuando se fusiona código a la rama principal — requiere un paso de despliegue explícito separado, así que el estado real de producción puede quedar temporalmente detrás de lo último fusionado hasta ese paso.
- **Frontend**: servidor Express minimalista que sirve páginas HTML estáticas multi-página (sin SPA), inyecta la URL del backend en tiempo de arranque a través de un archivo de configuración servido dinámicamente, y expone una ruta de verificación de salud para el balanceador de carga de la plataforma de hosting.
- **Variables de entorno separadas por ambiente** (desarrollo/producción) para: la URL del backend, el secreto de siembra inicial, y las credenciales de los proveedores externos de notificaciones (correo/WhatsApp) — nunca compartidas entre ambientes, configuradas independientemente en cada uno.
- **Lección reutilizable sobre CDN/caché**: cuando el hosting de archivos estáticos está detrás de una red de distribución de contenido (CDN), no toda directiva de "no cachear" es igual de efectiva — hay bordes de CDN que solo respetan la directiva más estricta y agresiva (evitar cualquier caché) e ignoran silenciosamente directivas más suaves (revalidar antes de usar), aplicando su propio tiempo de vida por defecto de todos modos. Si un archivo estático necesita garantizar que la versión más reciente se sirva justo después de cada despliegue, conviene probar empíricamente contra el CDN real cuál directiva funciona, en vez de asumir que la semánticamente "correcta" según el estándar es la que ese borde de CDN específico respeta.

---

## 23. Estrategia de pruebas

- **Pruebas automatizadas extensas** (varios cientos de casos) contra un simulador del backend que corre en memoria, sin necesitar un deployment real — cubre reglas de negocio, validaciones, y casos límite de cada módulo.
- **Sin verificación de tipos local dedicada** — la verificación de tipos ocurre como parte del propio paso de sincronización con el deployment de desarrollo real (cualquier error de tipos se detecta ahí, no en una herramienta aparte).
- **Verificación empírica contra un deployment de desarrollo real** antes de dar cualquier cambio por terminado — las pruebas automatizadas en memoria no bastan por sí solas para confirmar que algo funciona de verdad contra la infraestructura real (ej. si una librería específica corre en el runtime real sin problemas, si una integración externa realmente entrega lo que dice entregar).
- **Datos de prueba siempre desechables y limpiados**: cualquier verificación manual contra un ambiente real (dev o producción) usa sesiones/usuarios/roles creados específicamente para la prueba, nombrados de forma que se reconozcan como temporales, e invalidados/eliminados al terminar — nunca se deja "basura de prueba" mezclada con datos reales.

---

## 24. Mapa de pantallas

| Pantalla | Quién la usa | Qué hace |
|---|---|---|
| Inicio de sesión | todos | Login usuario/contraseña, "recordar en este dispositivo" |
| Panel de Control | según rol | Dashboard de KPIs, con vistas segmentadas (compras/calidad/gerencia) + pestaña de administración |
| Catálogo de Materiales | admin / rol con permiso | Alta y edición del maestro de materiales |
| Parámetros de Producción | admin | Configuración operativa global + fórmula de receta |
| Entradas con Costeo | compras / admin | Registro de recepción de material + costeo con factura real |
| Cierre de Turno | operador de piso | Captura consolidada de producción/consumo/merma al final de cada turno |
| Corrección de Capturas | admin | Corrige cierres/entradas ya guardados, con auditoría completa |
| Ajustes de Inventario | admin | Entradas/salidas manuales fuera del flujo normal |
| Configuración de Alertas | admin | Umbrales, destinatarios y canales de las 7 reglas de alerta |
| Reporte Diario | admin / rol con permiso | Destinatarios de correo/WhatsApp, hora de envío, historial de envíos reales |
| Gestión de Usuarios | admin | Alta, edición, desactivación, reset de contraseña |
| Gestión de Roles | admin | Alta, edición de páginas/vistas permitidas por rol |

---

## 25. Reglas de negocio invariantes (nunca deben romperse)

1. **Costeo estrictamente PEPS/FIFO** — nunca promedio ponderado.
2. **El material reciclado internamente siempre reingresa a inventario en $0** — evita duplicar el costo de la merma.
3. **El costo de la merma se absorbe en el costo por unidad buena producida**, no se contabiliza como línea de gasto separada.
4. **El punto de reorden siempre se calcula por fórmula**, con posibilidad de override manual, pero el valor calculado sigue visible como referencia (nunca se oculta al fijar uno manual).
5. **Todo movimiento queda con fecha y trazabilidad completa** — nada se sobrescribe, todo se acumula históricamente (ver sección 1.3).
6. **Siempre debe quedar al menos un usuario activo con privilegios administrativos completos.**
7. **Ningún rol personalizable puede auto-otorgarse acceso a las pantallas que administran usuarios/roles** (evita escalación de privilegios).
8. **Un ajuste manual de inventario nunca puede generar un faltante** (a diferencia del consumo de producción, que sí lo tolera para el material reciclado interno) — cualquier faltante en un ajuste manual solo puede ser un error de captura.
9. **La fecha de cualquier evento se valida siempre en servidor**, nunca se confía en lo que envíe el cliente sin verificar.
10. **Un fallo en una pieza opcional (ej. un adjunto, un canal de notificación sin credenciales) nunca debe bloquear el resto de una operación que sí puede completarse.**
11. **La importación de inventario inicial y el sembrado de datos base solo pueden correr una vez** (por material, o por deployment) — protegidos explícitamente contra reejecución accidental.
12. **Nunca se usan diálogos nativos del navegador** para confirmaciones o errores — solo componentes propios de la interfaz.

---

## 26. Glosario

- **Capa de costo**: lote de material valuado a un costo unitario específico, con cantidad original y restante — la unidad atómica del costeo PEPS.
- **Ledger inmutable**: registro de eventos que solo permite insertar filas nuevas, nunca editar/borrar las existentes; el estado actual se reconstruye (o se cachea) a partir de la suma de esos eventos.
- **Día operativo**: la fecha de negocio a la que pertenece un evento, que puede diferir de la fecha calendario del reloj cuando la operación cruza medianoche.
- **Soft-delete**: marcar un registro como inactivo en vez de borrarlo físicamente, preservando su historial para auditoría.
- **Vigente / no vigente**: patrón para marcar qué versión de un dato corregido es la actual, sin borrar las versiones anteriores.
- **Bypass de acceso**: un permiso que anula cualquier restricción de páginas/vistas específicas — acceso total incondicional.
- **Idempotencia**: garantía de que repetir la misma operación (por reintento o reejecución) no produce un efecto duplicado.
- **Degradación con gracia**: cuando una pieza opcional de una operación falla, el resto de la operación continúa igual, y el fallo queda registrado pero aislado.
