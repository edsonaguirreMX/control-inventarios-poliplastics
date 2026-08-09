import { defineConfig } from 'vitest/config';

// Pruebas del backend de Convex — corren contra un backend simulado en
// memoria (convex-test), no contra el deployment real. Requieren el
// environment "edge-runtime" porque es lo más cercano al runtime real de
// Convex (ver docs oficiales de convex-test).
export default defineConfig({
  test: {
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test'] } },
  },
});
