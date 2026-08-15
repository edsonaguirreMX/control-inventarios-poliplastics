// Cliente de Convex compartido por todas las pantallas + wrapper de sesión.
//
// Este archivo es el punto de entrada que empaqueta scripts/build-client.mjs
// (esbuild) en public/js/convex-client.js — las páginas cargan ese archivo
// generado, nunca este directamente, porque el import "convex/browser" solo
// se resuelve dentro del bundle, no en un <script type="module"> plano.
import { ConvexClient } from 'convex/browser';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';

const TOKEN_KEY = 'tejaflex_token';
const REMEMBER_KEY = 'tejaflex_remember';

const convexUrl = window.__CONVEX_URL__;
if (!convexUrl) {
  console.error(
    '[session.js] window.__CONVEX_URL__ no está definido — asegúrate de cargar /config.js antes de este script.'
  );
}
const client = convexUrl ? new ConvexClient(convexUrl) : null;

// "Recordar en este dispositivo" (checkbox del login) → token en localStorage
// (sobrevive cerrar el navegador). Sin marcar → sessionStorage (se borra al
// cerrar la pestaña). Solo uno de los dos storages tiene el token a la vez.
function getToken() {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || null;
}

function setToken(token, remember) {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  if (remember) {
    localStorage.setItem(REMEMBER_KEY, '1');
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(REMEMBER_KEY);
    sessionStorage.setItem(TOKEN_KEY, token);
  }
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REMEMBER_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

// undefined = todavía no se consultó al servidor; null = se consultó y no hay sesión válida.
let cachedUser;

async function login(usuario, password, remember) {
  if (!client) throw new Error('Cliente de Convex no inicializado (falta CONVEX_URL).');
  const result = await client.action(api.authActions.login, {
    usuario,
    password,
    remember: !!remember,
  });
  setToken(result.token, !!remember);
  cachedUser = { nombre: result.nombre, usuario: result.usuario, rol: result.rol };
  return cachedUser;
}

async function getUser() {
  if (cachedUser !== undefined) return cachedUser;
  const token = getToken();
  if (!token || !client) {
    cachedUser = null;
    return null;
  }
  try {
    cachedUser = await client.query(api.auth.me, { token });
  } catch (err) {
    console.error('[session.js] Error consultando la sesión:', err);
    cachedUser = null;
  }
  return cachedUser;
}

async function logout() {
  const token = getToken();
  clearToken();
  cachedUser = null;
  if (token && client) {
    try {
      await client.mutation(api.auth.logout, { token });
    } catch (err) {
      // El token local ya se limpió — un error de red aquí no debe bloquear el logout visual.
      console.warn('[session.js] logout en servidor falló (token local ya se limpió):', err);
    }
  }
}

// EDS-89: logout automático tras 10 minutos de inactividad — la sesión
// quedaba abierta indefinidamente mientras el navegador siguiera abierto,
// sin importar cuánto tiempo llevara sola la pantalla. Se activa una sola
// vez por carga de página (iniciarMonitorInactividad se llama desde
// requireRole, que ya corre en las 10 pantallas protegidas — nunca en
// login-acceso.html, que no llama requireRole y no tiene sesión que
// cuidar). Revisa por intervalo en vez de resetear un setTimeout en cada
// evento — mousemove puede disparar cientos de veces por segundo y no
// hace falta esa precisión para un timeout de 10 minutos.
const INACTIVIDAD_MS = 10 * 60 * 1000;
const INTERVALO_CHEQUEO_MS = 15 * 1000;
let ultimaActividad = Date.now();
let monitorInactividadIniciado = false;

function marcarActividad() {
  ultimaActividad = Date.now();
}

function iniciarMonitorInactividad() {
  if (monitorInactividadIniciado) return;
  monitorInactividadIniciado = true;
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach((evento) =>
    window.addEventListener(evento, marcarActividad, { passive: true })
  );
  setInterval(async () => {
    if (Date.now() - ultimaActividad >= INACTIVIDAD_MS) {
      await logout();
      window.location.href = '/login-acceso.html?motivo=inactividad';
    }
  }, INTERVALO_CHEQUEO_MS);
}

/**
 * Exige que haya sesión y que el rol esté en `roles`; si no, redirige a
 * login-acceso.html y deja la promesa colgada (no tiene caso que el resto
 * del script de la página siga corriendo si ya estamos navegando fuera).
 * Llamar al inicio de cada página protegida. Devuelve el usuario si pasa.
 */
async function requireRole(roles) {
  const user = await getUser();
  if (!user || !roles.includes(user.rol)) {
    window.location.href = '/login-acceso.html';
    return new Promise(() => {});
  }
  iniciarMonitorInactividad();
  return user;
}

/**
 * Wrapper para llamar queries/mutations/actions de Convex inyectando el
 * token automáticamente. `fnRef` es una referencia de api.* (ej.
 * api.materiales.listCatalogo). `kind` es 'query' | 'mutation' | 'action'.
 */
async function call(fnRef, args = {}, kind = 'query') {
  if (!client) throw new Error('Cliente de Convex no inicializado (falta CONVEX_URL).');
  const fullArgs = { ...args, token: getToken() };
  if (kind === 'mutation') return client.mutation(fnRef, fullArgs);
  if (kind === 'action') return client.action(fnRef, fullArgs);
  return client.query(fnRef, fullArgs);
}

// EDS-73: extrae un mensaje legible de un error de Convex. Los errores de
// negocio del backend se lanzan como `ConvexError('mensaje')` precisamente
// para que su `.data` (el mensaje original, íntegro) SÍ llegue al cliente
// — Convex redacta el `.message` de cualquier `Error` normal en producción
// antes de mandarlo al navegador (se ve completo solo en dev o por CLI),
// así que `err.message` a secas ya no basta para mostrar el mensaje real.
// Con ConvexError, `.data` es justo lo que el backend pasó al construirlo
// — en este proyecto siempre un string, pero se cubre el caso objeto por
// si algún día se pasa `{ code, message }` en vez de un string plano.
function mensajeError(err) {
  if (err instanceof ConvexError) {
    return typeof err.data === 'string' ? err.data : JSON.stringify(err.data);
  }
  return err?.message || String(err);
}

// true si `err` es un ConvexError — es decir, el backend lo lanzó a
// propósito como mensaje de negocio seguro de mostrar tal cual (ver nota
// de mensajeError arriba). false para cualquier error inesperado/técnico
// (red caída, bug interno, etc.), que nunca debe mostrarse crudo al
// usuario. Reemplaza el patrón viejo y frágil de "checar por regex si
// err.message se parece a un mensaje conocido" (EDS-73).
function esErrorDeNegocio(err) {
  return err instanceof ConvexError;
}

window.Session = { login, getUser, logout, requireRole, call, mensajeError, esErrorDeNegocio };
window.__convexClient = client;
// Las páginas HTML normales no pasan por esbuild (solo este archivo lo
// hace) — no pueden hacer `import { api } from '.../_generated/api'` ellas
// mismas, esa ruta no la sirve Express y aunque la sirviera, el navegador
// no puede resolver el bare import "convex/server" de adentro sin
// bundler. Por eso `api` se expone aquí como global — cualquier página que
// ya cargue /js/convex-client.js (todas las conectadas) puede usar
// `window.api.modulo.funcion` como referencia para Session.call().
window.api = api;
