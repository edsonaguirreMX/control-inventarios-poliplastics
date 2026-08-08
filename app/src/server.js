import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const app = express();

// Railway (y cualquier balanceador) usa esto para saber si el servicio sigue vivo.
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('/', (req, res) => res.redirect('/login-acceso.html'));

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`Tejaflex — sirviendo pantallas en http://localhost:${PORT}`);
});
