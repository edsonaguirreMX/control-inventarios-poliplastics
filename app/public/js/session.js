// Cliente de Convex compartido por todas las pantallas + wrapper de sesión.
//
// Este archivo es el punto de entrada que empaqueta scripts/build-client.mjs
// (esbuild) en public/js/convex-client.js — las páginas cargan ese archivo
// generado, nunca este directamente, porque el import "convex/browser" solo
// se resuelve dentro del bundle, no en un <script type="module"> plano.
import { ConvexClient } from 'convex/browser';
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

window.Session = { login, getUser, logout, requireRole, call };
window.__convexClient = client;
// Las páginas HTML normales no pasan por esbuild (solo este archivo lo
// hace) — no pueden hacer `import { api } from '.../_generated/api'` ellas
// mismas, esa ruta no la sirve Express y aunque la sirviera, el navegador
// no puede resolver el bare import "convex/server" de adentro sin
// bundler. Por eso `api` se expone aquí como global — cualquier página que
// ya cargue /js/convex-client.js (todas las conectadas) puede usar
// `window.api.modulo.funcion` como referencia para Session.call().
window.api = api;
