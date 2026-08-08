import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');

// En desarrollo local, `npx convex dev` escribe CONVEX_URL en .env.local.
// En Railway (producción) esa variable llega vía el entorno del servicio y
// este archivo no existe — falla en silencio y sigue con process.env tal cual.
try {
  process.loadEnvFile(path.join(APP_DIR, '.env.local'));
} catch {
  // .env.local no existe (producción) — no es un error.
}
const PORT = process.env.PORT || 3000;

const app = express();

// Railway (y cualquier balanceador) usa esto para saber si el servicio sigue vivo.
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Inyecta la URL del deployment de Convex en tiempo de arranque (no queda
// hardcodeada en el bundle estático) — las páginas cargan esto antes de
// /js/convex-client.js.
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.__CONVEX_URL__ = ${JSON.stringify(process.env.CONVEX_URL || '')};`);
});

app.get('/', (req, res) => res.redirect('/login-acceso.html'));

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Tejaflex — sirviendo pantallas en http://localhost:${PORT}`);
});
