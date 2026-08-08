# Historial de Cambios y Mejoras — Control de Materias Primas (Tejaflex)

> Registro exhaustivo de todo lo trabajado en este proyecto: desde la lectura de la especificación funcional hasta el despliegue de la aplicación viva en Railway. Incluye decisiones de diseño, iteraciones, correcciones explícitas del usuario (incluyendo reversiones), reglas de negocio fijadas, y la infraestructura técnica construida.
>
> Nota sobre Linear: esta sesión de trabajo no tenía el conector de Linear disponible al momento de generar este documento, por lo que este historial no quedó registrado como tareas ahí — se recomienda crear en Linear una tarea retroactiva de "Documentación: historial de cambios" y adjuntar este archivo, para cumplir con la regla del proyecto de que todo quede rastreado en el gestor de tareas.

---

## 0. Punto de partida

Se leyó `Documento_Funcionalidades_Control_Materias_Primas.md` como especificación de referencia obligatoria para todo el proyecto. Define:

- **10 módulos**: Catálogo de Materiales, Parámetros de Producción y Receta, Entradas (recepción), Salidas (consumo por línea), Merma, Costos, Dashboard (por rol), Reglas de negocio, Fuera de alcance, Usuarios/Roles/Flujo de captura.
- **5 reglas de negocio no negociables**:
  1. Costeo estrictamente PEPS/FIFO por capas (cantidad + costo unitario + fecha) — nunca promedio ponderado.
  2. El triturado (merma reciclada) reingresa a inventario valuado en $0.
  3. El costo de la merma se absorbe en el costo real por kg bueno producido, no es una línea de gasto separada.
  4. Punto de reorden = consumo diario promedio × (lead time + stock de seguridad en días, default 7), con override manual visible junto al valor calculado.
  5. Trazabilidad total: todo movimiento lleva fecha, nada se sobrescribe, todo se acumula históricamente.
- **Roles**: Operador de línea, Admin/Edson, Gerente/Comercial, Compras, Calidad/Producción.
- **Fuera de alcance v1**: líneas Lambrín y Thermo-PVC, integración con proveedores, facturación/CONTPAQi.

Todo el trabajo posterior se hizo respetando estas reglas.

---

## 1. Diseño de las 10 pantallas (mockups HTML/CSS/JS)

Cada pantalla se construyó como un artifact HTML autocontenido (fuentes embebidas en base64, sin dependencias externas), con tema claro/oscuro, y se validó antes de publicar con tres capas: balance de etiquetas, `node --check` sobre el JS embebido, y simulación de interacciones reales con `jsdom`.

### 1.1 Cierre de Turno (pantalla móvil del operador)

La pantalla que más iteraciones tuvo:

1. **3 propuestas visuales distintas** generadas primero, para elegir dirección de diseño.
2. El usuario pidió mezclar: **Propuesta B con los colores de la Propuesta A**.
3. Al revisar, el usuario corrigió el rumbo: **solo Propuesta A**, con un cambio de fondo importante — la materia prima es compartida entre las dos líneas, así que **debe poder capturarse sin asignarla a una línea**. Por línea/turno solo se capturan Consumo, Producción y Merma.
4. Rediseño como **wizard con dos flujos separados**:
   - **Entrada de material** (2 pasos, sin línea — va a almacén general compartido).
   - **Cierre de turno** (4 pasos: Línea/Turno → Consumo → Producción y Merma → Resumen).
5. Se incorporó la **fórmula real de producción** (kg por "carga"), con el detalle de que el **Masterbatch de color faltaba** — el usuario lo corrigió explícitamente: *"El masterbatch sí tiene un consumo, olvidé ponerlo, y es de 2.5 kg por carga."*
6. Se agregó **validación en tiempo real durante la captura**: advertencias inline junto al campo, con un patrón de "reconocimiento" (`data-state="ack"`) donde el operador debe confirmar explícitamente ("Sí, es correcto") antes de continuar.
   - **Bug encontrado y corregido**: la función de avance de wizard (`tryAdvance`) recalculaba las advertencias de todos los campos antes de dejar avanzar, lo que **revivía advertencias que el operador ya había confirmado** segundos antes. Se corrigió para que solo se revise el estado actual del DOM, sin recomputar.
7. **Rango de cargas preparadas**: se acotó a **entre 10 y 20 cargas** por turno. Esto obligó a recalcular en cascada los valores de ejemplo (cargas=14, metros=505, caballetes 1.05=12, caballetes 1.06=8, merma≈66kg/3.2%) para que no aparecieran advertencias falsas al cargar la pantalla.
8. **Fórmula fija final (kg por carga)**:

   | Material | kg / carga | Nota |
   |---|---|---|
   | HDPE reciclado peletizado | 25 | Comparte cupo con HDPE virgen (sustituto, default 0) |
   | HDPE reciclado en hojuela | 50 | |
   | HDPE reciclado hojuela sin lavar | 7.5 | |
   | Carbonato de calcio | 50 | |
   | Masterbatch de color | 2.5 | Agregado tras corrección del usuario |
   | Aditivo UV | 1.5 | |
   | Triturado (interno) | ≈12.5 | Aproximado, varía |
   | **Total** | **149 kg/carga** | |

9. **(Mejora transversal, ver sección 3)** Sesión visible del operador + "Cerrar sesión", y atribución de quién cerró cada turno / registró cada entrada.

### 1.2 Panel de Control (dashboard multi-rol)

- 4 roles con vistas distintas: **Compras**, **Calidad y Producción**, **Gerencia y Comercial**, **Admin** (ve todo + switcher de vista).
- Se agregó a Compras la **cantidad a pedir por material**, tomada de Catálogo de Materiales.
- Se agregó a Calidad y Producción una **gráfica de producción en metros por turno y por línea**, con acumulado semanal y mensual, todo en metros — con **línea de objetivo editable** superpuesta en cada gráfica.
- Se **quitó** la comparación de consumo real vs. teórico (pedido explícito del usuario).
- Las gráficas por turno/línea se cambiaron de línea a **gráfica de columnas**, por solicitud del usuario.
- **Bell de alertas** (🔔) integrado, filtrado por rol, con acceso directo a Configuración de Alertas.
- **Exportación**: CSV (existencias, producción, merma, costo) vía Blob + `<a download>`, y PDF vía `window.print()` con CSS de impresión dedicado que fuerza todas las secciones visibles (`body.print-all`).
- Roles de acceso ligados a Login (ver 1.5): al entrar por `?role=`, el usuario ve solo su vista y el switcher se oculta (excepto Admin).

### 1.3 Catálogo de Materiales y Parámetros de Producción y Fórmula

- Se **reconciliaron ambas pantallas** para que no haya dos fuentes de verdad: el "% meta en mezcla" del Catálogo quedó **de solo lectura (🔒)**, derivado matemáticamente del `kgPorCarga` definido en Parámetros, en vez de poder editarse de forma independiente.
- Costo estándar, lead time, stock de seguridad y punto de reorden manual (con el valor calculado siempre visible como referencia, según regla de negocio #4) viven en Catálogo.

### 1.4 Corrección de Capturas

- Pantalla para corregir hasta **los últimos 10 días** de Cierres de turno o Entradas de material, seleccionando día + línea + turno.
- Nació de una necesidad explícita del usuario: *"En caso de que haya un error en la captura de algunos de los datos del cierre o en la entrada de materiales poder modificarlos."*
- **(Mejora transversal, ver sección 3)** Bitácora de auditoría: quién corrigió y cuándo.

### 1.5 Login y Selección de Rol

- Iteración de diseño: de tiles con PIN → **usuario y contraseña unificado**, con pestañas para Operador y Administración con la **misma estructura** (el usuario pidió explícitamente no diferenciarlas).
- **Sin relación fija operador↔línea/turno** — hay rotación, así que el login no asigna línea ni turno.
- **"Recordar mis datos en este dispositivo"**: guarda usuario (no contraseña) en `localStorage`, por pestaña.
- **Bug reportado por el usuario**: al entrar con un usuario de Compras, se cargaban todas las secciones del Panel de Control en vez de solo Compras. Se investigó a fondo (incluyendo `WebFetch` sobre el artifact publicado) — el código en aislado se comportaba correctamente en pruebas con `jsdom`; se documentó como una posible limitación de la arquitectura de sandboxing de artifacts (navegación in-app vs. pestaña nueva) sin poder confirmarlo al 100% de forma remota.
- **(Mejora transversal, ver sección 3)** El login ahora propaga el **nombre real** de la persona (no solo el rol) a las siguientes pantallas.

### 1.6 Gestión de Usuarios

- Catálogo de usuarios con nombre, usuario (texto libre, no forzado a ser correo) y contraseña editable — pedido explícito: *"El username no tiene que ser necesariamente un correo electrónico... se debería de tener un catálogo de usuarios."*
- **Ciclo de contraseña temporal — implementado y luego revertido por completo:**
  1. El usuario pidió: *"Cambio de contraseña obligatorio en primer ingreso. La contraseña solo la podrá modificar el administrador desde la pantalla de usuarios."*
  2. Se implementó un flujo completo de contraseña temporal que bloqueaba el login hasta cambiarla.
  3. El usuario **corrigió la interpretación**: *"Yo voy a generar la contraseña. Es decir no habrá contraseña temporal. Sólo la que yo ponga."*
  4. Se **revirtió por completo**: se quitó el campo/flag `temp`, la función `blockedPanelHtml()`, el CSS `.success-check.locked` y `.temp-tag`, y todas sus referencias — verificado con `jsdom` que todas las cuentas (incluida la que quedaba bloqueada en la demo) vuelven a entrar normalmente.
- Función 🎲 para generar contraseña aleatoria (la única función que usa `Math.random()` real, ya que aquí sí se espera variación en cada clic).

### 1.7 Entradas con Costeo

- El operador solo captura kg (sin costo) en Cierre de Turno; aquí Compras/Admin completa **costo unitario, proveedor y folio**.
- Muestra las **capas de costeo PEPS** vigentes por material — cuidando que la suma de capas coincida exactamente con las existencias mostradas en Panel de Control (ej. HDPE reciclado peletizado: 4,800 kg @ $14.10 + 6,000 kg @ $15.28 = 10,800 kg).
- Exportación CSV y PDF.

### 1.8 Configuración de Alertas

- 7 reglas de alerta configurables (turno sin cerrar, material crítico, material por vencer, merma alta, producción baja, costo alto, entrada sin costear), cada una con umbral, destinatarios, canal y activa/inactiva.
- Historial de alertas disparadas.
- Integrado con el bell de Panel de Control (subconjunto de las mismas reglas, filtrado por rol).

### 1.9 Reporte Diario

- Configuración de un reporte automático **diario a las 2:00 pm**, en PDF, con:
  - Producción por turno/línea/total, acumulado semanal y mensual (metros), comparación contra objetivo.
  - Costo real por metro.
  - Materiales en alerta con inventario y punto de reorden.
- Checklist de contenido, destinatarios (correo y WhatsApp, con alta/baja tipo "chip"), historial de envíos.
- **Conexión real**: el botón "Generar ahora" llama a Panel de Control con `?role=admin&autoprint=1`, lo que dispara automáticamente `exportPDF()` allá — verificado con `jsdom` que el parámetro realmente detona la impresión.

---

## 2. ¿Alguna otra recomendación? — mejoras sugeridas y su resolución

Al preguntarle al usuario si faltaba algo, se propusieron 3 mejoras. El usuario aprobó explícitamente las **dos primeras**:

1. ✅ **Sesión visible y "Cerrar sesión"** — implementada (sección 3.1).
2. ✅ **Bitácora de auditoría (quién hizo cada cambio)** — implementada (sección 3.2).
3. ⬜ Vista de "Bitácora" consolidada / extender atribución a Gestión de Usuarios, Catálogo y Parámetros — **propuesta pero no implementada**, el usuario indicó "así ya estamos bien para continuar."

También se identificó (no implementado aún) que Corrección de Capturas **sobrescribe el registro anterior** al guardar una corrección, lo que técnicamente no cumple al 100% la regla de negocio #5 ("nada se sobrescribe, todo se acumula históricamente") — quedó señalado como pendiente, no resuelto.

---

## 3. Mejoras transversales a las 10 pantallas

### 3.1 Sesión visible y "Cerrar sesión"

Implementado en **las 10 pantallas**:

- **Login** ahora agrega `?usuario=<Nombre>` (además de `?role=` para Admin) al redirigir a Cierre de Turno o Panel de Control.
- **Cierre de Turno**: barra de sesión persistente (fuera de los flujos, visible siempre) con iniciales + nombre, o "Sesión no identificada" si se entra sin pasar por Login. El toast de cierre/entrada y la tarjeta de cada Línea×Turno ahora dicen quién y cuándo se cerró.
- **Panel de Control**: el badge que antes solo mostraba el rol ahora muestra "Nombre · Rol" + enlace "Cerrar sesión" (incluido para Admin, que antes no tenía badge). Propaga automáticamente el nombre a los 6 accesos de Configuración y al enlace de Configuración de Alertas.
- **Las 7 pantallas de administración** (Catálogo, Parámetros, Corrección, Gestión de Usuarios, Entradas, Alertas, Reporte Diario) heredan la sesión desde Panel de Control vía query param, muestran el mismo widget, y devuelven el nombre al hacer clic en "‹ Panel de Control".
- Sin sesión (acceso directo a cualquier pantalla), cada una cae a un estado neutro con "Iniciar sesión" en vez de fallar.
- Validado con `jsdom` en las 10 pantallas, en ambos estados (con y sin sesión).

### 3.2 Bitácora de auditoría — quién hizo cada cambio

Implementado en **Corrección de Capturas**:

- Cada corrección (de un cierre de turno o de una entrada) guarda **quién** la hizo (de la sesión activa, con fallback a "Administrador" si no hay sesión) y **cuándo** (timestamp real del momento de guardar, `new Date()` real durante la demo).
- El tag "✏️ Editado" se acompaña de una línea "Corregido por *Nombre* · fecha, hora".
- Se dejaron dos ejemplos precargados (un cierre y una entrada ya marcados como editados) para ver la bitácora sin tener que corregir algo primero.
- Verificado con `jsdom`: ejemplo precargado, corrección en vivo de un cierre, y corrección en vivo de una entrada.

---

## 4. De mockups a aplicación viva

### 4.1 Decisiones de arquitectura

- **Backend + base de datos**: **Convex** (elegido por el usuario) — sustituye a un backend tradicional tipo Express+Postgres; hospeda datos y funciones (queries/mutations) en su propia nube, con deployment separado de Railway.
- **Frontend**: se mantienen las 10 pantallas en **HTML/CSS/JS vanilla** tal como fueron diseñadas (decisión explícita de no reescribirlas en React, para no perder el trabajo visual ya aprobado), servidas por un servidor **Node/Express** delgado.
- **Hosting del frontend**: **Railway**.
- **Control de versiones**: **GitHub**, repo `edsonaguirreMX/control-inventarios-poliplastics`.
- **Gestión de proyecto**: **Linear** — con la regla explícita del usuario: *"Siempre todo en Linear, prohibido hacer algo sin crear una tarea en Linear."* (ver sección 4.6)

### 4.2 Esqueleto del repositorio

Estructura creada bajo `Control Inventarios Poliplastics/`:

```
Control Inventarios Poliplastics/
├── Documento_Funcionalidades_Control_Materias_Primas.md   (spec de referencia)
├── README.md
├── .gitignore
├── diseno/            → los 10 mockups originales (referencia de diseño)
└── app/               → la aplicación viva
    ├── package.json
    ├── .gitignore
    ├── .env.example
    ├── railway.json
    ├── README.md
    ├── convex/        → backend Convex (schema y funciones — pendiente de completar)
    └── src/
        └── server.js  → servidor Express
    └── public/        → copia de los 10 mockups, adaptados para navegación interna
```

### 4.3 Convex

- Instalado (`convex` + `express` como dependencias).
- Se corrió `npx convex dev` — como no se hizo login a una cuenta en la nube, Convex **configuró automáticamente un deployment local** (backend corriendo en `127.0.0.1:3210`, con SQLite local en `.convex/`).
- **Pendiente explícito**: para que Railway pueda hablar con la base de datos en producción, hace falta autenticarse con una cuenta real de Convex en la nube (`npx convex login`) y generar un deployment de producción — el usuario decidió posponer este paso.
- Esquema de datos (materiales, fórmula, cierres, entradas con capas PEPS, usuarios, alertas, reportes, bitácora) **todavía no se ha modelado** — es el siguiente paso pendiente del plan.

### 4.4 GitHub

- No se contaba con `gh` (GitHub CLI) instalado en la máquina, así que no se pudo crear ni conectar el repo automáticamente al inicio.
- Se evaluaron dos mecanismos de autenticación para el primer `push`:
  - **Token de acceso personal clásico** (propuesto por el usuario, generado/usado una vez/borrado inmediatamente).
  - **Llave SSH** (recomendada) — comparación explícita hecha con el usuario: SSH no requiere pegar ningún secreto en la conversación, tiene menor superficie de riesgo (solo sirve para git, no para la API completa de GitHub como un token classic), y no necesita repetirse en cada sesión de trabajo futura.
  - El usuario eligió **SSH**.
- Se generó una llave dedicada (`~/.ssh/id_ed25519_github`, sin passphrase para permitir automatización desde comandos no interactivos), se configuró `~/.ssh/config` con un `Host github.com` explícito, y el usuario agregó la llave pública en GitHub (`https://github.com/settings/ssh/new`).
- **Primer commit y push exitoso** — contenido: spec, los 10 mockups de `diseno/`, y el esqueleto inicial de `app/`.
- Identidad de git corregida (`user.name`/`user.email` locales al repo) para que los commits queden atribuidos correctamente a Edson Aguirre.

### 4.5 Railway

- Primer intento de deploy **falló**: Railway (Railpack) escaneó la raíz del repo, que solo tiene mockups y documentación, y no encontró un `package.json` — el mensaje de error sugería fijar el "Root Directory" a `app`.
- El usuario no encontró la sección "Source" en Settings del dashboard de Railway (la UI varía).
- **Se optó por desplegar vía CLI de Railway en vez de depender del dashboard**:
  1. `npx @railway/cli login` (login por navegador).
  2. `npx @railway/cli link --project overflowing-tenderness` (proyecto ya creado por el usuario; el otro proyecto disponible, `innovative-sparkle`, no era el correcto).
  3. Servicio auto-seleccionado: `control-inventarios-poliplastics`.
- Antes de desplegar, se detectaron y corrigieron **dos problemas reales** que habrían tumbado el build de todas formas:
  - El `package.json` tenía un script `build` que corría `convex deploy` — habría fallado porque no hay credenciales de Convex en la nube configuradas. **Se quitó.**
  - `src/server.js`, referenciado en `package.json`, **no existía todavía**. Se creó: sirve `public/` de forma estática, redirige `/` a `login-acceso.html`, y expone `/healthz` para Railway.
  - Se copiaron los 10 mockups de `diseno/` a `app/public/`, y se **reescribieron los enlaces de navegación entre pantallas** (que apuntaban a `https://claude.ai/code/artifact/...`) para que apunten a **rutas relativas locales** (`/login-acceso.html`, `/panel-control.html`, etc.) — 30 reemplazos en total across los 10 archivos. Esto hace que la navegación completa (Login → Cierre de Turno → Panel de Control → pantallas de Admin) funcione dentro de la misma app desplegada, sin salir a claude.ai.
  - Se agregó `railway.json` fijando explícitamente el comando de arranque (`npm start`), para no depender de que Railpack lo adivine.
  - Probado localmente antes de subir (`curl` contra `/`, `/login-acceso.html`, `/healthz`, `/panel-control.html`) para confirmar que todo respondía antes de gastar un ciclo de deploy.
- `railway up` ejecutado directo desde `app/` — build exitoso (Nixpacks, Node 24).
- Se generó un **dominio público** (no existía ninguno todavía): `railway domain` → `https://control-inventarios-poliplastics-production.up.railway.app`
- **Verificado en producción**: redirección a login (302), pantallas sirviendo (200), healthcheck OK.

> **La aplicación está en línea, hoy, en:**
> **https://control-inventarios-poliplastics-production.up.railway.app**
> (con datos de ejemplo — todavía no conectada a Convex en la nube)

### 4.6 Linear

- El usuario pidió conectar Linear como gestor de proyecto, con una regla estricta: **ninguna acción del proyecto se hace sin una tarea en Linear que la respalde**.
- Yo no tengo manera de conectar un MCP server por mi cuenta — es una acción que solo se hace desde la cuenta del usuario (claude.ai → Settings → Connectors).
- Primer intento: el usuario conectó Linear, pero la conversación en curso no lo detectó — se identificó que la lista de herramientas disponibles queda fija al iniciar cada sesión, así que hacía falta abrir una conversación nueva.
- Quedó registrado en memoria (`linear-required-workflow.md`) el estado de la conexión para que futuras sesiones lo verifiquen antes de asumir que hay que crear tareas desde cero: workspace "Edson", team "Edson" (`82a03ebe-936a-4199-9ecd-2b3ea309d44b`), proyecto **`control-inventarios-poliplastics`** (`https://linear.app/edsonaguirre/project/control-inventarios-poliplastics-dd2fd70294d7`), confirmado conectado desde 2026-08-07, vacío (0 issues) a esa fecha.
- Este documento se generó en una sesión distinta a la que confirmó la conexión de Linear, por lo que **no se creó todavía la tarea correspondiente en Linear para este trabajo** — pendiente de regularizar.

---

## 5. Estado actual del plan

| # | Paso | Estado |
|---|---|---|
| 1 | Cuenta y proyecto de Convex | ⚠️ Local únicamente — falta login a la nube |
| 2 | Esqueleto del repo | ✅ |
| 3 | Esquema de datos en Convex | ⬜ Pendiente |
| 4 | Funciones de Convex por módulo | ⬜ Pendiente |
| 5 | Migrar cada pantalla a datos reales | ⬜ Pendiente |
| 6 | Semilla de datos | ⬜ Pendiente |
| 7 | Prueba local end-to-end | ⬜ Pendiente |
| 8 | Git init + commit + GitHub (SSH) | ✅ |
| 9 | Deploy a Railway | ✅ (con datos de ejemplo, sin Convex) |
| 10 | Linear conectado y en uso | ⚠️ Conectado, pero sin tareas creadas todavía |

---

## 6. Enlaces de referencia

| Recurso | URL |
|---|---|
| Repositorio GitHub | https://github.com/edsonaguirreMX/control-inventarios-poliplastics |
| Aplicación en Railway (viva) | https://control-inventarios-poliplastics-production.up.railway.app |
| Proyecto en Linear | https://linear.app/edsonaguirre/project/control-inventarios-poliplastics-dd2fd70294d7 |
| Login y Selección de Rol (mockup) | https://claude.ai/code/artifact/8f102232-a2b3-4fc8-b6d7-a21b67e5e04d |
| Cierre de Turno (mockup) | https://claude.ai/code/artifact/012ac544-2123-4bcc-a891-b999f1f9988d |
| Panel de Control (mockup) | https://claude.ai/code/artifact/7422e82c-b431-4e09-9713-4479c1724fdc |
| Catálogo de Materiales (mockup) | https://claude.ai/code/artifact/822b457a-9605-403f-bd88-a60a80277abe |
| Parámetros de Producción y Fórmula (mockup) | https://claude.ai/code/artifact/dae4efb8-0259-4711-86d7-b6efde829b21 |
| Corrección de Capturas (mockup) | https://claude.ai/code/artifact/78f3138c-7051-4734-bab0-fcdf4379a2c8 |
| Gestión de Usuarios (mockup) | https://claude.ai/code/artifact/a488c010-2daf-4b2c-a303-485f9886a186 |
| Entradas con Costeo (mockup) | https://claude.ai/code/artifact/0c1405d6-6d85-40ec-afcc-54d378e96fd3 |
| Configuración de Alertas (mockup) | https://claude.ai/code/artifact/ee8d41b8-1d87-4770-ba01-ff1dbe33b4a4 |
| Reporte Diario (mockup) | https://claude.ai/code/artifact/5e291cff-a6db-432c-99a0-3e92ec67998d |

---

## 7. Decisiones explícitas del usuario que no deben revertirse sin pedirlo

Estas correcciones ya se aplicaron y representan la intención real del usuario, no la interpretación inicial:

1. La materia prima es compartida entre líneas — las **entradas de material nunca se asignan a una línea**.
2. El Masterbatch de color **sí consume** (2.5 kg/carga) — no se debe volver a omitir.
3. Rango válido de cargas preparadas por turno: **10 a 20**.
4. El username **no** tiene que ser un correo — es texto libre asignado por el Admin.
5. **No existe contraseña temporal** — el Admin asigna la contraseña definitiva directamente; no hay flujo de "cambio obligatorio en primer ingreso".
6. En las gráficas de producción por turno/línea del Panel de Control: **columnas**, no líneas.
7. Se **quitó** la comparación de consumo real vs. teórico del Panel de Control.
8. **Todo el trabajo del proyecto pasa por una tarea en Linear** — no se avanza nada sin ella (ver sección 4.6 para el estado actual, que todavía no cumple esta regla al 100%).
