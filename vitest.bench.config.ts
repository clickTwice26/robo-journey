import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/**
 * Benchmarks, run alone.
 *
 * `fileParallelism: false` and a single fork are the whole point: a real-time assertion is only
 * meaningful when the process is not fighting the rest of the suite for cores.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@robo-journey/sim-core': src('sim-core'),
      '@robo-journey/parts': src('parts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.bench.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 120_000,
  },
});
