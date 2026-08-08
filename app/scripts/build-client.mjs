// Empaqueta el cliente de Convex (+ nuestro session.js) en un solo archivo
// estático que las páginas HTML pueden cargar sin depender de un CDN externo.
// Corre con `npm run build` (Railway lo ejecuta antes de `npm start`).
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_JS = path.join(__dirname, '..', 'public', 'js');

await build({
  entryPoints: [path.join(PUBLIC_JS, 'session.js')],
  outfile: path.join(PUBLIC_JS, 'convex-client.js'),
  bundle: true,
  format: 'esm',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
});

console.log('✔ Bundle generado: public/js/convex-client.js');
