import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const src = (pkg: string) =>
  fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));

/** Repo root, where `.env` lives — one file configures both halves of the dev setup. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  /**
   * Read the repo-root `.env`.
   *
   * The empty prefix loads every variable, not only `VITE_`-prefixed ones: these configure the dev
   * server itself and are never exposed to client code. Reading it here rather than wrapping the
   * `vite` binary avoids depending on where npm hoists that binary, which differs between
   * workspace layouts — the wrapper approach broke immediately for exactly that reason.
   */
  const env = { ...loadEnv(mode, REPO_ROOT, ''), ...process.env };

  /**
   * Ports.
   *
   * Deliberately away from the crowded defaults — 3000, 5000, 5173, 8080 — so this project runs
   * beside other applications without anyone having to remember which one claimed a port first.
   * Override in `.env`, and update `.claude/launch.json` to match.
   */
  const studioPort = Number(env.RJ_STUDIO_PORT ?? 28611);
  const servicePort = Number(env.RJ_SERVICE_PORT ?? 28610);

  return {
    plugins: [react()],
    resolve: {
      // Point at source rather than dist so editing the engine hot-reloads the app.
      alias: {
        '@robo-journey/sim-core': src('sim-core'),
        '@robo-journey/parts': src('parts'),
      },
    },
    server: {
      // Bind IPv4 loopback explicitly. Vite's default resolves to [::1] on macOS, so the dev
      // server ends up IPv6-only while the compile service is on 127.0.0.1 -- anything reaching
      // for 127.0.0.1 then gets connection refused from a server that is plainly listening.
      // Loopback rather than 0.0.0.0 keeps it off the local network.
      host: '127.0.0.1',
      port: studioPort,
      // Fail rather than drift. Vite silently increments when a port is taken, which would leave
      // the dev server somewhere the launch config and the API proxy are not looking.
      strictPort: true,
      proxy: {
        // The browser cannot run avr-gcc, and must never hold the Gemini key, so everything under
        // /api goes to the local service.
        '/api': {
          target: `http://127.0.0.1:${servicePort}`,
          rewrite: (path: string) => path.replace(/^\/api/, ''),
        },
      },
    },
    worker: { format: 'es' as const },
  };
});
