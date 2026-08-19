/**
 * The M0 gate, end to end.
 *
 * Source text -> arduino-cli -> Intel HEX -> emulated ATmega328P -> observed pin edge. Every stage
 * is the real one; nothing is stubbed. If this passes, the spine the rest of the project hangs off
 * is sound.
 *
 * Requires Docker and the `robo-journey/arduino-cli` image. Skipped automatically when absent, so a
 * checkout without Docker still runs a green suite -- the committed fixture covers the emulator
 * half in `sim-core`.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Atmega328p, loadHex } from '@robo-journey/sim-core';
import { ArduinoCompiler, DEFAULT_IMAGE } from '../src/index.js';

function dockerImageAvailable(): boolean {
  try {
    const out = execFileSync('docker', ['images', '-q', DEFAULT_IMAGE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

const BLINK = `
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`.trimStart();

const describeIfDocker = dockerImageAvailable() ? describe : describe.skip;

describeIfDocker('compile -> emulate spine', () => {
  const compiler = new ArduinoCompiler();

  it('compiles Blink and runs it at 1 Hz on the emulated MCU', async () => {
    const result = await compiler.compile({
      files: [{ name: 'sketch.ino', contents: BLINK }],
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.hex).toBeDefined();
    expect(result.elf?.byteLength).toBeGreaterThan(0);

    const mcu = new Atmega328p({ progMem: loadHex(result.hex!) });
    const edges: number[] = [];
    mcu.onPinChange((change) => {
      if (change.pin.label === 'D13') edges.push(change.time);
    });
    mcu.runFor(2.6);

    // Drop the pinMode glitch, then every remaining gap is one half-period.
    const steady = edges.slice(1);
    expect(steady.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < steady.length; i++) {
      const interval = steady[i]! - steady[i - 1]!;
      expect(interval).toBeGreaterThan(0.5);
      expect(interval).toBeLessThan(0.501);
    }
  });

  it('returns diagnostics instead of firmware when the sketch does not compile', async () => {
    const result = await compiler.compile({
      files: [{ name: 'sketch.ino', contents: 'void setup() { int x = nope; }\nvoid loop() {}\n' }],
    });

    expect(result.ok).toBe(false);
    expect(result.hex).toBeUndefined();

    const error = result.diagnostics.find((d) => d.severity === 'error');
    expect(error).toBeDefined();
    // Sketch-relative, so the editor can map it to the open tab without knowing about containers.
    expect(error!.file).toBe('sketch.ino');
    expect(error!.line).toBe(1);
    expect(error!.message).toMatch(/nope/);
  });

  it('is content-addressed, so identical sources hash identically', async () => {
    const files = [{ name: 'sketch.ino', contents: BLINK }];
    const a = await compiler.compile({ files });
    const b = await compiler.compile({ files });
    expect(a.hash).toBe(b.hash);
    expect(a.hex).toBe(b.hex);

    const different = await compiler.compile({
      files: [{ name: 'sketch.ino', contents: BLINK.replace('500', '250') }],
    });
    expect(different.hash).not.toBe(a.hash);
  });

  it('refuses sketch filenames that escape the sketch directory', async () => {
    await expect(
      compiler.compile({ files: [{ name: '../escape.ino', contents: BLINK }] }),
    ).rejects.toThrow(/Unsafe sketch file name/);
  });
});
