# Tejaflex — Control de Materias Primas

Aplicación interna para controlar inventario y costeo PEPS/FIFO de las materias primas de producción (Línea 1 y Línea 2). Backend en **Convex**, frontend en **Node/Express** sirviendo HTML multipágina (sin SPA) conectado directo a Convex desde el navegador.

El diseño técnico completo (spec funcional, reglas de negocio, mockups) vive en la raíz del repo: `Documento_Funcionalidades_Control_Materias_Primas.md` y `diseno/`.

## Arquitectura

- **`convex/`** — schema, queries/mutations/actions, crons. Fuente única de verdad de datos e inventario (PEPS por capas de costo, ledger inmutable `capaMovimientos`).
- **`src/server.js`** — Express: sirve las páginas estáticas de `public/`, inyecta la URL del deployment de Convex en `/config.js`, expone `/healthz` para el balanceador.
- **`public/*.html`** — una página por pantalla (login, panel de control, cierre de turno, entradas, catálogo, parámetros, corrección de capturas, alertas, reporte diario, gestión de usuarios). Cada una habla con Convex directo vía `public/js/convex-client.js` (bundle generado, ver abajo) y `public/js/session.js` (token, `requireRole`, wrapper de llamadas).
- Auth casera sobre Convex: tabla `sessions` + `bcryptjs`, sin proveedor externo. Roles: `operador`, `admin`, `gerencia`, `compras`, `calidad`.

## Requisitos

- Node >= 20.6 (usa `process.loadEnvFile`, ver `package.json` → `engines`)
- Una cuenta de Convex (gratis para desarrollo) — https://convex.dev

## Desarrollo local

```bash
npm install

# Terminal 1 — backend: crea/actualiza el deployment de Convex, deja corriendo
npx convex dev
# La primera vez pide loguearte y crear/elegir un proyecto; escribe
# CONVEX_DEPLOYMENT y CONVEX_URL en .env.local automáticamente (no se sube a git).

# Terminal 2 — empaqueta el cliente de Convex para el navegador
npm run build
# (o corre esto cada vez que cambies convex/schema.ts o algo que afecte
# la API generada — build-client.mjs empaqueta convex/browser + el `api`
# generado en public/js/convex-client.js)

# Terminal 3 — sirve las páginas
npm run dev:web
# → http://localhost:3000 (o PORT=xxxx npm run dev:web para otro puerto)
```

Variables de entorno (ver `.env.example`):

| Variable | De dónde sale | Uso |
|---|---|---|
| `CONVEX_DEPLOYMENT` | la escribe `npx convex dev` | identifica el deployment para el CLI |
| `CONVEX_URL` | la escribe `npx convex dev` | la usa `src/server.js` para inyectarla en `/config.js`, que cargan las páginas antes de `convex-client.js` |

### Sembrar datos iniciales

La base arranca vacía. Para crear el catálogo de 8 materiales, parámetros de producción, las 7 reglas de alerta y el usuario admin inicial:

1. En el dashboard de Convex del deployment de desarrollo: `npx convex env set SEED_SECRET <valor-largo-y-aleatorio>` (una sola vez).
2. Dashboard → Functions → `seed:seedInicial` → Run, con `{ "seedSecret": "<el-mismo-valor>" }`.
3. La respuesta trae la contraseña temporal del admin (`usuario: edson`) — **se muestra una sola vez**, cópiala de ahí. Cámbiala después desde Gestión de Usuarios.
4. `seedInicial` es idempotente: si `materiales` ya tiene datos, no hace nada.

El **inventario inicial real** (kg y costo por material del corte físico de arranque) se carga aparte — ver tarea 3.5 / `EDS-41` en Linear, bloqueada hasta tener esas cifras.

## Pruebas

```bash
npm test              # vitest run — suite completa contra convex-test (sin deployment real)
npx vitest run <archivo>.test.ts   # un solo archivo
```

CI (GitHub Actions, `.github/workflows/ci.yml`) corre en cada push/PR: `npm ci`, `npm test`, `npm run build`, `node --check src/server.js`, `node --check scripts/build-client.mjs`.

## Despliegue a producción

1. **Convex**: `npx convex deploy` crea/actualiza el deployment de producción. Configura ahí también `SEED_SECRET` (uno propio, distinto al de desarrollo) antes de correr `seedInicial` en producción.
2. **Railway** (o cualquier host que corra Node): apunta esta carpeta (`app/`) como raíz del proyecto.
   - Build command: `npm install && npm run build`
   - Start command: `npm start` (= `node src/server.js`)
   - Variable de entorno: `CONVEX_URL` con la del deployment de **producción** de Convex (no la de desarrollo). `CONVEX_DEPLOYMENT` no hace falta en producción — solo lo usa el CLI local.
   - `/healthz` para el health check del servicio.

## Estructura del proyecto

```
app/
├── convex/              # backend: schema, funciones, crons, tests (*.test.ts junto a cada módulo)
├── public/              # una página HTML por pantalla + js/session.js (fuente) + js/convex-client.js (generado)
├── src/server.js        # Express estático + /config.js + /healthz
├── scripts/build-client.mjs  # esbuild: empaqueta convex/browser + api generado
└── .env.local           # generado por `npx convex dev`, no se sube a git
```

## Convenciones del proyecto (para quien siga desarrollando)

- **Patrón `*Impl` + wrapper delgado**: la lógica vive en una función plana (`xImpl(ctx, args)`), la `mutation`/`query`/`action` registrada es un wrapper delgado — permite componer varias operaciones dentro de una sola transacción y reusar la lógica entre distintos entry points.
- **Mutations atómicas de batch**: un botón "Guardar cambios" de una tabla completa = una sola mutation que recibe todas las filas editadas, nunca un loop de mutations independientes del cliente.
- **Nada se sobrescribe**: correcciones y recierres nunca borran el registro anterior — lo marcan `vigente:false`/`agotada:true` y agregan uno nuevo, con snapshot en `correccionesHistorial`. El ledger `capaMovimientos` es inmutable.
- **Sin diálogos nativos**: nunca `alert()`/`confirm()`/`prompt()` — rompen la automatización de pruebas en navegador y no matchean el lenguaje visual del proyecto. Usar banners inline (`.field-warn.error`) o confirmaciones de 2 clics / modales.
- **Autorización server-side siempre**: cada query/mutation/action sensible valida el rol con `requireRole(ctx, token, [...])` — nunca confiar en que el frontend oculte un botón.
