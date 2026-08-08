// Cliente de Convex compartido por todas las pantallas + wrapper de sesión.
//
// Este archivo es el punto de entrada que empaqueta scripts/build-client.mjs
// (esbuild) en public/js/convex-client.js — las páginas cargan ese archivo
// generado, nunca este directamente, porque el import "convex/browser" solo
// se resuelve en el bundle, no en un <script type="module"> plano.
//
// Placeholder de la tarea 0.2 (EDS-27): solo expone el cliente de Convex para
// verificar que el bundler funciona de punta a punta. La API real de sesión
// (Session.login/requireRole/logout/call) se implementa en la tarea 1.2
// (EDS-30), que reemplaza este archivo.
import { ConvexClient } from 'convex/browser';

const convexUrl = window.__CONVEX_URL__;
if (!convexUrl) {
  console.error(
    '[session.js] window.__CONVEX_URL__ no está definido — asegúrate de cargar /config.js antes de este script.'
  );
}

const client = convexUrl ? new ConvexClient(convexUrl) : null;

window.__convexClient = client;

// API completa (login, requireRole, getUser, logout, call) pendiente — tarea 1.2.
window.Session = {};
