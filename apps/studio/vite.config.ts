import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const src = (pkg: string) =>
  fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Point at source rather than dist so editing the engine hot-reloads the app.
    alias: {
      '@robo-journey/sim-core': src('sim-core'),
      '@robo-journey/parts': src('parts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The browser cannot run avr-gcc, so compilation goes to the local service.
      '/api/compile': { target: 'http://127.0.0.1:4747', rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
  worker: { format: 'es' },
});
