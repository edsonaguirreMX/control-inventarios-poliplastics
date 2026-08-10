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

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Tejaflex — sirviendo pantallas en http://localhost:${PORT}`);
});
