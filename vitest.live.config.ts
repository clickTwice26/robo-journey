import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/**
 * Live tests: these call external APIs and cost money.
 *
 * Kept out of the default suite so `npm test` stays free, fast and offline. They skip themselves
 * when no API key is present, so a checkout without one still runs green rather than red.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@robo-journey/sim-core': src('sim-core'),
      '@robo-journey/parts': src('parts'),
      '@robo-journey/datasheet': src('datasheet'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.live.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
