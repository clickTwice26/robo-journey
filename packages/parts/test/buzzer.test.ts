/**
 * What a buzzer is doing, measured off its drive.
 *
 * The pitch of a passive buzzer is not a property of the part -- it is whatever rate the sketch is
 * toggling the pin at, which is the entire reason to choose one over an active buzzer. So the app
 * has to measure it rather than look it up, and this is the arithmetic that does.
 *
 * Mirrors what the worker does with the same recorder window, so a change to one without the other
 * shows up here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadHex } from '@robo-journey/sim-core';
import { buildCircuit, installBuiltinManifests, parseProject } from '../src/index.js';

const firmware = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../sim-core/test/fixtures/${name}`, import.meta.url)), 'utf8');

/** A buzzer on D13, driven by blink -- a 1 Hz square wave, which is a pitch we know. */
function buzzerOnBlink(type: string) {
  installBuiltinManifests();
  const project = parseProject({
    version: 1,
    parts: [
      { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
      { id: 'buz', type, x: 0, y: 80 },
    ],
    wires: [
      { id: 'w1', from: 'buz:+', to: 'uno1:D13' },
      { id: 'w2', from: 'buz:-', to: 'uno1:GND' },
    ],
  });
  return buildCircuit(project, { progMem: loadHex(firmware('blink.hex')) });
}

/**
 * The worker's measurement, in one place so the test and the app cannot drift.
 *
 * Counts crossings of half the peak in one direction; a full cycle crosses twice, so counting one
 * direction counts cycles.
 */
function measure(values: number[], times: number[]): { peak: number; hz: number } {
  let peak = 0;
  for (const value of values) peak = Math.max(peak, Math.abs(value));

  const threshold = peak / 2;
  const crossings: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i - 1]!) < threshold && Math.abs(values[i]!) >= threshold) {
      crossings.push(times[i]!);
    }
  }

  // Between the first and last crossing, not across the whole window: the window edges do not
  // land on cycle boundaries, and dividing by the window over-counts by up to a whole cycle.
  const elapsed = crossings.length >= 2 ? crossings[crossings.length - 1]! - crossings[0]! : 0;
  return { peak, hz: elapsed > 0 ? (crossings.length - 1) / elapsed : 0 };
}

describe('an active buzzer on a blinking pin', () => {
  it('sees the full drive voltage when the pin is high', () => {
    const { board, nodes } = buzzerOnBlink('buzzer-active');
    board.runFor(0.2);

    const across =
      board.circuit.voltage(nodes.get('buz:+')!) - board.circuit.voltage(nodes.get('buz:-')!);
    // A 60 ohm buzzer on a 25 ohm pin driver is a divider, so it is not the full five volts --
    // which is exactly the sort of thing worth not rounding away.
    expect(Math.abs(across)).toBeGreaterThan(3);
  });
});

describe('a passive buzzer', () => {
  it('has no pitch of its own -- the pin gives it one', () => {
    // Blink toggles D13 at 1 Hz, so the drive waveform is 1 Hz. A real tone() runs thousands of
    // times faster; the arithmetic is identical and this is the rate a test can afford to run.
    const { board } = buzzerOnBlink('buzzer-passive');
    board.runFor(4.2);

    const span = board.recorder.span();
    const window = board.recorder.window('digital:D13', span.from, span.to, 4000)!;
    const { hz } = measure(Array.from(window.values), Array.from(window.times));

    expect(hz).toBeCloseTo(1, 2);
  });

  it('reads as silent while the pin is never driven', () => {
    installBuiltinManifests();
    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'buz', type: 'buzzer-passive', x: 0, y: 80 },
      ],
      // Wired to a pin the sketch never touches.
      wires: [
        { id: 'w1', from: 'buz:+', to: 'uno1:D5' },
        { id: 'w2', from: 'buz:-', to: 'uno1:GND' },
      ],
    });

    const { board, nodes } = buildCircuit(project, { progMem: loadHex(firmware('blink.hex')) });
    board.runFor(0.2);

    const across =
      board.circuit.voltage(nodes.get('buz:+')!) - board.circuit.voltage(nodes.get('buz:-')!);
    // Under a volt is the threshold the app uses for "not sounding".
    expect(Math.abs(across)).toBeLessThan(1);
  });
});
