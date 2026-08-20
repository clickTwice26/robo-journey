/**
 * The world around the circuit.
 *
 * Two things are being tested and they are different. The field maths -- does a flame fifty
 * millimetres away amount to less than one at ten -- and the coupling: does putting the flame on
 * the canvas actually change what a sketch reads off a pin. The first is arithmetic; the second is
 * the feature.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadHex } from '@robo-journey/sim-core';
import {
  ManifestDevice,
  buildCircuit,
  environmentSources,
  fieldAt,
  installBuiltinManifests,
  isDriven,
  parseProject,
  partDefinition,
  type EnvironmentSource,
} from '../src/index.js';

const firmware = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../sim-core/test/fixtures/${name}`, import.meta.url)), 'utf8');

const blink = () => loadHex(firmware('blink.hex'));

const source = (over: Partial<EnvironmentSource> = {}): EnvironmentSource => ({
  id: 's1',
  quantity: 'light',
  x: 0,
  y: 0,
  intensity: 800,
  reachMm: 50,
  active: true,
  ...over,
});

describe('a field', () => {
  it('leaves the part alone when nothing of that kind is placed', () => {
    // The sliders have to keep working exactly as they did, or adding the toolkit would break
    // every project that used them.
    expect(fieldAt([], 'light', 0, 0, 120)).toBe(120);
    expect(fieldAt([source({ quantity: 'sound' })], 'light', 0, 0, 120)).toBe(120);
  });

  it('is half strength at the reach, which is what makes reaches comparable', () => {
    const sources = [source({ reachMm: 50 })];
    expect(fieldAt(sources, 'light', 50, 0, 0)).toBeCloseTo(400, 0);
  });

  it('falls off with the square of the distance beyond that', () => {
    const sources = [source({ reachMm: 50 })];
    // Twice the reach is a quarter of the way out on an inverse square, plus the softening term.
    expect(fieldAt(sources, 'light', 100, 0, 0)).toBeCloseTo(160, 0);
    expect(fieldAt(sources, 'light', 200, 0, 0)).toBeLessThan(50);
  });

  it('adds the ambient the part is already set to', () => {
    expect(fieldAt([source()], 'light', 0, 0, 120)).toBeCloseTo(920, 0);
  });

  it('adds light from two lamps but not decibels from two speakers', () => {
    const lamps = [source({ id: 'a' }), source({ id: 'b' })];
    expect(fieldAt(lamps, 'light', 0, 0, 0)).toBeCloseTo(1600, 0);

    // Two 80 dB sources are 83 dB, not 160. Decibels are a logarithm; the pressures behind them
    // are what add.
    const speakers = [
      source({ id: 'a', quantity: 'sound', intensity: 80 }),
      source({ id: 'b', quantity: 'sound', intensity: 80 }),
    ];
    expect(fieldAt(speakers, 'sound', 0, 0, 0)).toBeCloseTo(83, 0);
  });

  it('takes the strongest magnet rather than the sum', () => {
    const magnets = [
      source({ id: 'a', quantity: 'magnet', intensity: 1, reachMm: 15 }),
      source({ id: 'b', quantity: 'magnet', intensity: 1, reachMm: 15 }),
    ];
    expect(fieldAt(magnets, 'magnet', 0, 0, 0)).toBeCloseTo(1, 3);
  });

  it('measures distance to the nearest obstacle rather than summing them', () => {
    const walls = [
      source({ id: 'near', quantity: 'distance', x: 40, y: 0 }),
      source({ id: 'far', quantity: 'distance', x: 200, y: 0 }),
    ];
    // A millimetre on the canvas is a centimetre of world, so a wall 40 mm away reads 40 cm.
    expect(fieldAt(walls, 'distance', 0, 0, 400)).toBeCloseTo(40, 3);
  });

  it('stops radiating when switched off', () => {
    expect(fieldAt([source({ active: false })], 'light', 0, 0, 10)).toBe(10);
    expect(isDriven([source({ active: false })], 'light')).toBe(false);
  });
});

describe('a flame placed on the workspace', () => {
  it('is four things at once', () => {
    // A fire is infrared, heat, light and smoke. A simulator whose flame only triggered the sensor
    // you aimed at it would let a design pass that a real fire would set off three other ways.
    const project = parseProject({
      version: 1,
      parts: [{ id: 'f1', type: 'stim-flame', x: 10, y: 10 }],
      wires: [],
    });

    const kinds = environmentSources(project).map((s) => s.quantity).sort();
    expect(kinds).toEqual(['flame', 'gas', 'light', 'temperature']);
  });

  it('carries the position it was dropped at', () => {
    const project = parseProject({
      version: 1,
      parts: [{ id: 'f1', type: 'stim-flame', x: 42, y: 17 }],
      wires: [],
    });
    for (const s of environmentSources(project)) {
      expect(s.x).toBe(42);
      expect(s.y).toBe(17);
    }
  });
});

describe('a flame and a flame sensor', () => {
  /** The sensor on its own, with the flame wherever the test puts it. */
  function scene(flameX: number) {
    installBuiltinManifests();
    return parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'fs', type: 'flame-sensor', x: 0, y: 100 },
        { id: 'fire', type: 'stim-flame', x: flameX, y: 100 },
      ],
      wires: [
        { id: 'w1', from: 'fs:VCC', to: 'uno1:5V' },
        { id: 'w2', from: 'fs:GND', to: 'uno1:GND' },
        { id: 'w3', from: 'fs:AOUT', to: 'uno1:A0' },
      ],
    });
  }

  /** What the worker does: work the field out and hand it to the device. */
  function applyWorld(project: ReturnType<typeof scene>, built: ReturnType<typeof buildCircuit>) {
    const sources = environmentSources(project);
    for (const part of project.parts) {
      const device = built.devices.get(part.id);
      if (!(device instanceof ManifestDevice)) continue;
      for (const variable of partDefinition(part.type).state ?? []) {
        if (!variable.quantity || !isDriven(sources, variable.quantity)) continue;
        const ambient =
          typeof part.props[variable.name] === 'number'
            ? (part.props[variable.name] as number)
            : variable.default;
        device.setState(
          variable.name,
          Math.min(variable.max, Math.max(variable.min, fieldAt(sources, variable.quantity, part.x, part.y, ambient))),
        );
      }
    }
  }

  /** The sensor's analog output, which is what a sketch would read. */
  function outputVolts(flameX: number): number {
    const project = scene(flameX);
    const built = buildCircuit(project, { progMem: blink() });
    expect(built.problems).toEqual([]);
    applyWorld(project, built);
    built.board.runFor(0.01);
    return built.board.circuit.voltage(built.nodes.get('fs:AOUT')!);
  }

  it('reads near nothing with the flame far away', () => {
    expect(outputVolts(400)).toBeLessThan(0.5);
  });

  it('climbs as the flame is dragged closer', () => {
    const far = outputVolts(120);
    const near = outputVolts(20);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(3);
  });

  it('sets off the gas sensor sitting next to it too', () => {
    // Nobody wired the flame to the gas sensor. It is smoke, and the gas sensor is in the smoke.
    installBuiltinManifests();
    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'gas', type: 'mq2', x: 0, y: 100 },
        { id: 'fire', type: 'stim-flame', x: 20, y: 100 },
      ],
      wires: [
        { id: 'w1', from: 'gas:VCC', to: 'uno1:5V' },
        { id: 'w2', from: 'gas:GND', to: 'uno1:GND' },
      ],
    });

    const built = buildCircuit(project, { progMem: blink() });
    applyWorld(project, built);
    const device = built.devices.get('gas') as ManifestDevice;
    expect(device.getState('ppm')).toBeGreaterThan(1500);
  });
});

describe('a magnet and a reed switch', () => {
  it('has to be almost touching, because a dipole falls off as the cube', () => {
    installBuiltinManifests();
    const build = (magnetX: number) => {
      const project = parseProject({
        version: 1,
        parts: [
          { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
          { id: 'reed', type: 'reed-switch', x: 0, y: 100 },
          { id: 'mag', type: 'stim-magnet', x: magnetX, y: 100 },
        ],
        wires: [
          { id: 'w1', from: 'reed:VCC', to: 'uno1:5V' },
          { id: 'w2', from: 'reed:GND', to: 'uno1:GND' },
        ],
      });
      const built = buildCircuit(project, { progMem: blink() });
      const sources = environmentSources(project);
      const device = built.devices.get('reed') as ManifestDevice;
      device.setState('magnet', fieldAt(sources, 'magnet', 0, 100, 0));
      return device.getState('magnet');
    };

    expect(build(5)).toBeGreaterThan(0.9);
    // Two reaches out, an inverse cube has already thrown almost all of it away.
    expect(build(30)).toBeLessThan(0.2);
  });
});
