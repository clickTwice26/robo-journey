import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Point cross-package imports at source rather than dist, so tests never depend on build order.
    alias: {
      '@robo-journey/sim-core': src('sim-core'),
      '@robo-journey/compile-service': src('compile-service'),
      '@robo-journey/parts': src('parts'),
      '@robo-journey/datasheet': src('datasheet'),
      '@robo-journey/accounts': src('accounts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Brings up a Postgres and a Redis for the run, and takes them away afterwards. Suites that
    // need them skip when Docker is not available rather than failing.
    globalSetup: ['./test/containers.ts'],
    // Long enough for a cold image pull on the first run.
    hookTimeout: 120_000,
    // Benchmarks are excluded here and run by `npm run bench`. Vitest runs test files in
    // parallel, so a wall-clock assertion competing with eleven other files measures CPU
    // contention rather than the solver -- it read 0.81x under load and 2.05x alone.
    exclude: ['**/node_modules/**', '**/dist/**'],
    // A cold AVR compile inside Docker takes a couple of seconds.
    testTimeout: 60_000,
  },
});
