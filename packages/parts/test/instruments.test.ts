/**
 * Instruments as parts.
 *
 * The measurements themselves are proved in `sim-core/test/meters.test.ts`. What matters here is
 * that they work as *placed components*: wired to arbitrary points through the same terminals and
 * wires everything else uses, reading circuit nodes the Arduino's own header never touches.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Multimeter, loadHex, type Ammeter } from '@robo-journey/sim-core';
import { buildCircuit, libraryProject, parseProject, probeChannel } from '../src/index.js';

const firmware = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../sim-core/test/fixtures/${name}`, import.meta.url)), 'utf8');

const blink = () => loadHex(firmware('blink.hex'));

/** A divider off the Uno's 5 V rail, with somewhere to put a probe in the middle of it. */
function dividerProject(extra: { parts: unknown[]; wires: unknown[] }) {
  return parseProject({
    version: 1,
    parts: [
      { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
      { id: 'r1', type: 'resistor', x: 0, y: 80, props: { ohms: 1000 } },
      { id: 'r2', type: 'resistor', x: 30, y: 80, props: { ohms: 1000 } },
      ...extra.parts,
    ],
    wires: [
      { id: 'w1', from: 'uno1:5V', to: 'r1:a' },
      { id: 'w2', from: 'r1:b', to: 'r2:a' },
      { id: 'w3', from: 'r2:b', to: 'uno1:GND' },
      ...extra.wires,
    ],
  });
}

describe('a multimeter on the canvas', () => {
  it('measures a node the Arduino has no pin on', () => {
    // The junction of two resistors: nowhere near the header, and the whole reason the meter is a
    // part with probes rather than a panel bolted to the board.
    const project = dividerProject({
      parts: [{ id: 'dmm', type: 'multimeter', x: 0, y: 120, props: { mode: 'volts' } }],
      wires: [
        { id: 'w4', from: 'dmm:V', to: 'r1:b' },
        { id: 'w5', from: 'dmm:COM', to: 'uno1:GND' },
      ],
    });

    const { board, devices, problems } = buildCircuit(project, { progMem: blink() });
    expect(problems).toEqual([]);
    board.runFor(0.01);

    const meter = devices.get('dmm') as Multimeter;
    expect(meter.reading).toBeCloseTo(2.5, 1);
    expect(meter.display()).toMatch(/^2\.4\d\d V|^2\.5\d\d V/);
  });

  it('puts its reading where the UI can find it', () => {
    const project = dividerProject({
      parts: [{ id: 'dmm', type: 'multimeter', x: 0, y: 120, props: { mode: 'volts' } }],
      wires: [
        { id: 'w4', from: 'dmm:V', to: 'uno1:5V' },
        { id: 'w5', from: 'dmm:COM', to: 'uno1:GND' },
      ],
    });

    const { board, devices } = buildCircuit(project, { progMem: blink() });
    board.runFor(0.01);

    const rows = devices.get('dmm')!.readout!();
    expect(rows[0]!.label).toBe('Reading');
    expect(rows[0]!.value).toMatch(/5\.0\d\d V/);
  });

  it('is a near short across a supply when the lead is in the current jack', () => {
    // Not an error, not a refusal -- the meter simply dies, the way it would on the bench.
    const project = dividerProject({
      parts: [{ id: 'dmm', type: 'multimeter', x: 0, y: 120, props: { mode: 'amps' } }],
      wires: [
        { id: 'w4', from: 'dmm:A', to: 'uno1:5V' },
        { id: 'w5', from: 'dmm:COM', to: 'uno1:GND' },
      ],
    });

    const { board, devices } = buildCircuit(project, { progMem: blink() });
    board.runFor(0.01);

    expect((devices.get('dmm') as Multimeter).display()).toBe('FUSE');
  });
});

describe('an ammeter on the canvas', () => {
  it('reads the current through the branch it is inserted into', () => {
    // Broken into the divider between the two resistors, which is the only way to use one.
    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'r1', type: 'resistor', x: 0, y: 80, props: { ohms: 1000 } },
        { id: 'amp', type: 'ammeter', x: 40, y: 80 },
      ],
      wires: [
        { id: 'w1', from: 'uno1:5V', to: 'r1:a' },
        { id: 'w2', from: 'r1:b', to: 'amp:in' },
        { id: 'w3', from: 'amp:out', to: 'uno1:GND' },
      ],
    });

    const { board, devices, problems } = buildCircuit(project, { progMem: blink() });
    expect(problems).toEqual([]);
    board.runFor(0.01);

    const meter = devices.get('amp') as Ammeter;
    expect(meter.amps).toBeCloseTo(0.005, 4);
    expect(meter.blown).toBe(false);
  });
});

describe('an oscilloscope on the canvas', () => {
  it('records a trace from a probe on a pin the sketch is driving', () => {
    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'scope', type: 'oscilloscope', x: 0, y: 80 },
      ],
      wires: [
        { id: 'w1', from: 'scope:CH1', to: 'uno1:D13' },
        { id: 'w2', from: 'scope:GND', to: 'uno1:GND' },
      ],
    });

    const { board, problems } = buildCircuit(project, { progMem: blink() });
    expect(problems).toEqual([]);

    // Blink holds D13 high for half a second, so a second and a bit catches both states.
    board.runFor(1.2);

    const channel = probeChannel('scope', 'CH1');
    expect(board.recorder.channelIds).toContain(channel);

    const span = board.recorder.span();
    const trace = board.recorder.window(channel, span.from, span.to)!;
    expect(trace.values.length).toBeGreaterThan(10);

    const high = Math.max(...trace.values);
    const low = Math.min(...trace.values);
    expect(high).toBeGreaterThan(4.5);
    expect(low).toBeLessThan(0.5);
  });

  it('floats when the ground clip is not connected', () => {
    // A probe with no reference is not measuring anything, and a scope that quietly referenced
    // circuit ground for you would hide the commonest mistake made with one.
    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'scope', type: 'oscilloscope', x: 0, y: 80 },
      ],
      wires: [{ id: 'w1', from: 'scope:CH1', to: 'uno1:5V' }],
    });

    const { board } = buildCircuit(project, { progMem: blink() });
    board.runFor(0.05);

    const span = board.recorder.span();
    const trace = board.recorder.window(probeChannel('scope', 'CH1'), span.from, span.to)!;
    const last = trace.values[trace.values.length - 1] ?? 0;
    expect(Math.abs(last)).toBeLessThan(1);
  });
});

describe('the probing example', () => {
  it('reads the divider it wires the meter across', () => {
    // The example is only worth shipping if its answer is the one you would work out on paper:
    // 5 V across two equal resistors puts 2.5 V at the junction, and the meter should say so.
    const project = libraryProject('probing')!.build();
    const { board, devices, problems } = buildCircuit(project, { progMem: blink() });
    expect(problems).toEqual([]);

    board.runFor(0.01);
    expect((devices.get('dmm1') as Multimeter).reading).toBeCloseTo(2.5, 1);
  });

  it('catches the blink on the scope, ground clip and all', () => {
    const project = libraryProject('probing')!.build();
    const { board } = buildCircuit(project, { progMem: blink() });
    board.runFor(1.2);

    const span = board.recorder.span();
    const trace = board.recorder.window(probeChannel('scope1', 'CH1'), span.from, span.to)!;
    expect(Math.max(...trace.values)).toBeGreaterThan(4.5);
    expect(Math.min(...trace.values)).toBeLessThan(0.5);
  });
});
