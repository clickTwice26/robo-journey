/**
 * Regenerate the committed firmware fixtures.
 *
 * The fixtures let `sim-core` test the emulator without Docker. They must stay in step with the
 * pinned toolchain, so this script is the only sanctioned way to refresh them.
 *
 *   npm run fixtures:build -w @robo-journey/compile-service
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ArduinoCompiler } from './compiler.js';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../sim-core/test/fixtures/', import.meta.url),
);

async function main(): Promise<void> {
  const compiler = new ArduinoCompiler();
  const entries = await readdir(FIXTURE_DIR);
  const sketches = entries.filter((name) => name.endsWith('.ino'));

  if (sketches.length === 0) {
    throw new Error(`No .ino fixtures found in ${FIXTURE_DIR}`);
  }

  for (const sketch of sketches) {
    const contents = await readFile(join(FIXTURE_DIR, sketch), 'utf8');
    const result = await compiler.compile({
      // arduino-cli wants the main file named after its directory; the compiler normalises to
      // "sketch.ino" internally, so the fixture's own name is free to be descriptive.
      files: [{ name: 'sketch.ino', contents }],
    });

    if (!result.ok || !result.hex) {
      for (const d of result.diagnostics) {
        console.error(`  ${d.file}:${d.line}: ${d.severity}: ${d.message}`);
      }
      throw new Error(`Failed to compile fixture ${sketch}`);
    }

    const target = join(FIXTURE_DIR, sketch.replace(/\.ino$/, '.hex'));
    await writeFile(target, result.hex, 'utf8');
    console.log(`  ${sketch} -> ${sketch.replace(/\.ino$/, '.hex')} (${result.hex.length} bytes)`);
  }

  console.log(`\nRegenerated ${sketches.length} fixture(s). Re-run the sim-core tests.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
