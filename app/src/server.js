import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');

// En desarrollo local, `npx convex dev` escribe CONVEX_URL en .env.local.
// En Railway (producción) esa variable llega vía el entorno del servicio y
// este archivo no existe — falla en silencio y sigue con process.env tal cual.
// process.loadEnvFile requiere Node >=20.6 (ver "engines" en package.json);
// si faltara en un runtime más viejo, el catch también lo cubre — el server
// sigue arrancando, solo sin CONVEX_URL en local hasta actualizar Node.
try {
  process.loadEnvFile(path.join(APP_DIR, '.env.local'));
} catch {
  // .env.local no existe (producción), o process.loadEnvFile no existe en
  // este runtime — ninguno de los dos casos debe tumbar el servidor.
}
const PORT = process.env.PORT || 3000;

const app = express();

// Railway (y cualquier balanceador) usa esto para saber si el servicio sigue vivo.
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Inyecta la URL del deployment de Convex en tiempo de arranque (no queda
// hardcodeada en el bundle estático) — las páginas cargan esto antes de
// /js/convex-client.js.
//
// Bug real encontrado en el smoke test post-deploy (2026-08-10): sin
// Cache-Control explícito, el CDN de Railway (Cloudflare) cacheó esta
// respuesta agresivamente (max-age=14400 por defecto) — una copia servida
// ANTES de configurar CONVEX_URL quedó atrapada en el edge y se le siguió
// sirviendo a todo mundo con la URL vacía por horas, aunque el origen ya
// respondía bien. Este endpoint depende de una variable de entorno del
// servidor — nunca debe cachearse en ningún nivel.
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(`window.__CONVEX_URL__ = ${JSON.stringify(process.env.CONVEX_URL || '')};`);
});

app.get('/', (req, res) => res.redirect('/login-acceso.html'));

// EDS-110 — mismo incidente que ya tuvo /config.js (ver comentario arriba,
// 2026-08-10): el CDN de Railway (Cloudflare) impone `max-age=14400` (4h)
// por defecto a cualquier respuesta sin Cache-Control explícito.
// express.static no manda ninguno propio salvo que se lo pidamos, así que
// /js/convex-client.js (el bundle real de session.js + cliente de Convex)
// podía quedar cacheado en el edge hasta 4 horas después de un deploy —
// un usuario que ya hubiera visitado el sitio seguía recibiendo JS viejo
// contra un backend ya nuevo (encontrado real: EDS-106, pantalla "a
// medias" tras el deploy de esa fase).
//
// Primer intento (mismo commit del hallazgo, ya reemplazado): solo
// `no-cache, must-revalidate` — sin `no-store`, para poder revalidar por
// ETag en vez de forzar red completa en cada carga. Verificado en LOCAL
// que Express sí mandaba ese header, pero en PRODUCCIÓN el edge de
// Cloudflare lo ignoraba y seguía sirviendo `max-age=14400` de todos
// modos (confirmado con curls a query strings nunca antes vistas,
// cf-cache-status: MISS igual devolvía el valor viejo) — ese edge
// concreto solo respeta `no-store` como señal real de "no cachear"; es
// el mismo motivo por el que /config.js ya usaba `no-store` desde el
// incidente de 2026-08-10. Se alinea aquí al mismo patrón, aceptando el
// costo (mínimo, app de bajo tráfico) de perder la revalidación por ETag
// a cambio de que el edge definitivamente no lo cachee.
app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(path.join('js', 'convex-client.js')) || filePath.endsWith(path.join('js', 'convex-client.js.map'))) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      }
    },
  })
);

app.listen(PORT, () => {
  console.log(`Tejaflex — sirviendo pantallas en http://localhost:${PORT}`);
});
