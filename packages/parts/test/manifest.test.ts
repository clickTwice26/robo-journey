/**
 * Component manifests: schema, semantic validation, and simulation.
 *
 * The end-to-end test is the important one. A datasheet-derived HC-SR04 manifest, loaded as data,
 * driven by a real sketch calling `pulseIn` -- and the number the sketch prints must match the
 * distance the manifest was told to report. Nothing about that path is compiled in: the component
 * arrived as JSON.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { digitalChannel, loadHex } from '@robo-journey/sim-core';
import {
  buildCircuit,
  manifestToPartDefinition,
  parseManifest,
  parseProject,
  registerPart,
  unregisterPart,
  validateManifest,
  type ComponentManifest,
} from '../src/index.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

const firmware = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../sim-core/test/fixtures/${name}`, import.meta.url)), 'utf8');

const hcsr04 = () => parseManifest(fixture('hc-sr04.json'));
const tmp36 = () => parseManifest(fixture('tmp36.json'));

describe('manifest schema', () => {
  it('parses a real datasheet-derived manifest', () => {
    const manifest = hcsr04();
    expect(manifest.id).toBe('hc-sr04');
    expect(manifest.pins).toHaveLength(4);
    expect(manifest.behavior.kind).toBe('pulse-echo');
  });

  it('applies documented defaults rather than leaving holes', () => {
    const manifest = tmp36();
    // clampToSupply defaults true: a real part cannot output more than it is fed.
    expect(manifest.behavior).toMatchObject({ clampToSupply: true });
    expect(manifest.provenance.unresolved).toEqual([]);
  });

  it('rejects an id that would not work as a part type', () => {
    expect(() => parseManifest({ ...(fixture('tmp36.json') as object), id: 'Not Valid' })).toThrow();
  });

  it('rejects an unknown schema version rather than guessing', () => {
    expect(() => parseManifest({ ...(fixture('tmp36.json') as object), schemaVersion: 2 })).toThrow();
  });
});

describe('semantic validation', () => {
  /** Deep-clone so each case can mutate freely. */
  const mutate = (change: (m: ComponentManifest) => void): ComponentManifest => {
    const manifest = hcsr04();
    change(manifest);
    return manifest;
  };

  it('accepts a coherent manifest', () => {
    expect(validateManifest(hcsr04()).ok).toBe(true);
    expect(validateManifest(tmp36()).ok).toBe(true);
  });

  it('rejects VIL above VIH', () => {
    // The single most consequential extraction error: it inverts every logic decision the part
    // makes, and the manifest is otherwise perfectly well-formed.
    const result = validateManifest(
      mutate((m) => {
        const trig = m.pins.find((p) => p.name === 'TRIG')!;
        if (trig.model.kind === 'digital-in') {
          trig.model.vih = 1.0;
          trig.model.vil = 2.5;
        }
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('VIL'))).toBe(true);
  });

  it('rejects a pin reference that does not resolve', () => {
    const result = validateManifest(
      mutate((m) => {
        if (m.behavior.kind === 'pulse-echo') m.behavior.echoPin = 'NOPE';
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('NOPE'))).toBe(true);
  });

  it('rejects a state reference that does not resolve', () => {
    // A behaviour reading a state variable nobody declares would silently never change.
    const result = validateManifest(
      mutate((m) => {
        if (m.behavior.kind === 'pulse-echo') m.behavior.state = 'missing';
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate pin names', () => {
    const result = validateManifest(
      mutate((m) => {
        m.pins[1]!.name = 'VCC';
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('Duplicate'))).toBe(true);
  });

  it('catches milliamps read as amps', () => {
    // The most common unit slip in datasheet extraction, and one that would let a simulated part
    // brown out a board that a real one would not.
    const result = validateManifest(
      mutate((m) => {
        m.limits.pinMaxAmps = 20;
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('implausible'))).toBe(true);
  });

  it('catches an implausible supply voltage', () => {
    const result = validateManifest(
      mutate((m) => {
        const vcc = m.pins.find((p) => p.name === 'VCC')!;
        if (vcc.model.kind === 'power') vcc.model.vNom = 5000;
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an active component with no power pin', () => {
    const result = validateManifest(
      mutate((m) => {
        m.pins = m.pins.filter((p) => p.model.kind !== 'power');
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('energised'))).toBe(true);
  });

  it('rejects a reserved I2C address', () => {
    const manifest = parseManifest({
      ...(fixture('tmp36.json') as Record<string, unknown>),
      id: 'fake-i2c',
      behavior: { kind: 'i2c-peripheral', address: 0x00, sdaPin: 'VOUT', sclPin: 'VS', registers: [] },
    });
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('reserved'))).toBe(true);
  });

  it('rejects an empty state range', () => {
    const result = validateManifest(
      mutate((m) => {
        m.state[0]!.min = 100;
        m.state[0]!.max = 10;
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('warns rather than fails when a datasheet simply omits something', () => {
    // A missing absolute maximum is normal in a cheap module's datasheet. Refusing the whole
    // component over it would be worse than saying so.
    const result = validateManifest(
      mutate((m) => {
        m.limits = {};
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.severity === 'warning')).toBe(true);
  });

  it('warns when a rangefinder cannot reach the top of its own range', () => {
    const result = validateManifest(
      mutate((m) => {
        if (m.behavior.kind === 'pulse-echo') m.behavior.timeoutSeconds = 0.001;
      }),
    );
    expect(result.issues.some((i) => i.message.includes('unreachable'))).toBe(true);
  });
});

describe('simulating a manifest', () => {
  afterEach(() => {
    unregisterPart('hc-sr04');
    unregisterPart('tmp36');
  });

  it('refuses to shadow a built-in part', () => {
    // A generated component quietly replacing the LED would change every existing project with no
    // indication why.
    const definition = manifestToPartDefinition(hcsr04());
    expect(() => registerPart({ ...definition, type: 'led' })).toThrow(/built-in/);
  });

  it('exposes the manifest pins as part pins', () => {
    const definition = manifestToPartDefinition(hcsr04());
    expect(definition.pins.map((p) => p.name)).toEqual(['VCC', 'TRIG', 'ECHO', 'GND']);
    expect(definition.width).toBe(45);
  });

  it('drives an analog output from a state variable', () => {
    registerPart(manifestToPartDefinition(tmp36()));

    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        // 25 C should give 0.5 + 0.25 = 0.75 V.
        { id: 't1', type: 'tmp36', x: 0, y: 60, props: { temperatureC: 25 } },
      ],
      wires: [
        { id: 'w1', from: 't1:VS', to: 'uno1:5V' },
        { id: 'w2', from: 't1:GND', to: 'uno1:GND' },
        { id: 'w3', from: 't1:VOUT', to: 'uno1:A0' },
      ],
    });

    const { board, problems } = buildCircuit(project, { progMem: loadHex(firmware('blink.hex')) });
    expect(problems).toEqual([]);
    board.runFor(0.01);

    // The TMP36's own transfer function, arriving through the solver at the ADC input.
    expect(board.voltage('A0')).toBeCloseTo(0.75, 2);
    expect(board.mcu.adc.channelValues[0]).toBeCloseTo(0.75, 2);
  });

  it('tracks the state variable as it changes', () => {
    registerPart(manifestToPartDefinition(tmp36()));

    for (const [celsius, expected] of [
      [0, 0.5],
      [25, 0.75],
      [100, 1.5],
    ] as const) {
      const project = parseProject({
        version: 1,
        parts: [
          { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
          { id: 't1', type: 'tmp36', x: 0, y: 60, props: { temperatureC: celsius } },
        ],
        wires: [
          { id: 'w1', from: 't1:VS', to: 'uno1:5V' },
          { id: 'w2', from: 't1:GND', to: 'uno1:GND' },
          { id: 'w3', from: 't1:VOUT', to: 'uno1:A0' },
        ],
      });
      const { board } = buildCircuit(project, { progMem: loadHex(firmware('blink.hex')) });
      board.runFor(0.005);
      expect(board.voltage('A0')).toBeCloseTo(expected, 2);
    }
  });

  /** Uno + HC-SR04 wired the standard way, at a chosen distance. */
  function sonarBoard(distanceCm: number) {
    registerPart(manifestToPartDefinition(hcsr04()));
    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 's1', type: 'hc-sr04', x: 0, y: 60, props: { distanceCm } },
      ],
      wires: [
        { id: 'w1', from: 's1:VCC', to: 'uno1:5V' },
        { id: 'w2', from: 's1:GND', to: 'uno1:GND' },
        { id: 'w3', from: 's1:TRIG', to: 'uno1:D9' },
        { id: 'w4', from: 's1:ECHO', to: 'uno1:D10' },
      ],
    });
    return buildCircuit(project, { progMem: loadHex(firmware('sonar.hex')) });
  }

  it('runs a rangefinder end to end, from JSON to a printed distance', () => {
    // The whole claim in one test. The component arrived as a datasheet-derived JSON file; the
    // sketch is real compiled firmware calling pulseIn; the echo pulse is produced by the manifest
    // runtime and carried through the solver as a voltage. What the sketch prints is what the
    // manifest was told to report.
    const { board, problems } = sonarBoard(40);
    expect(problems).toEqual([]);

    let output = '';
    board.mcu.onSerialByte((byte) => {
      output += String.fromCharCode(byte);
    });
    board.runFor(0.5);

    const readings = output
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);

    expect(readings.length).toBeGreaterThan(0);
    // pulseIn measures in microseconds and the sketch divides by 58, the module's own conversion.
    // A couple of centimetres of slack covers the solver's timestep granularity.
    for (const reading of readings) {
      expect(reading).toBeGreaterThan(37);
      expect(reading).toBeLessThan(43);
    }
  });

  it('reports a different distance when the state variable changes', () => {
    for (const distance of [10, 100, 200]) {
      const { board } = sonarBoard(distance);
      let output = '';
      board.mcu.onSerialByte((byte) => {
        output += String.fromCharCode(byte);
      });
      board.runFor(0.5);

      const readings = output
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((value) => Number.isFinite(value) && value > 0);

      expect(readings.length).toBeGreaterThan(0);
      // Within 5% or 1 cm, whichever is larger. The slack is not solver error: the sketch does
      // `micros / 58` in integer arithmetic, so a 575 us echo prints 9 rather than 10 -- exactly
      // what a real Uno prints, and a reminder that the simulator reproduces the sketch's bugs
      // along with its behaviour.
      const tolerance = Math.max(1, distance * 0.05);
      expect(Math.abs(readings[0]! - distance)).toBeLessThanOrEqual(tolerance);
    }
  });

  it('produces an echo pulse of the width the datasheet specifies', () => {
    // Asserted off the recorded waveform rather than through the sketch, so this measures the
    // manifest's fidelity rather than the sketch's integer division.
    for (const distance of [10, 40, 200]) {
      const { board } = sonarBoard(distance);
      board.runFor(0.25);

      const edges = board.recorder.edges(digitalChannel('D10'));
      const rise = edges.find((e) => e.level);
      const fall = edges.find((e) => !e.level && rise !== undefined && e.time > rise.time);
      expect(rise, `no echo rise at ${distance} cm`).toBeDefined();
      expect(fall, `no echo fall at ${distance} cm`).toBeDefined();

      const widthMicros = (fall!.time - rise!.time) * 1e6;
      // 58 us per centimetre, the module's own conversion factor.
      expect(widthMicros).toBeCloseTo(distance * 58, -1);
    }
  });

  it('leaves ECHO low until a trigger arrives', () => {
    const { board } = sonarBoard(40);
    // Before the sketch's first trigger, the echo line must be idle.
    board.runFor(0.0005);
    expect(board.voltage('D10')).toBeLessThan(1);
  });

  it('clamps the output to the supply, as a real part must', () => {
    // A TMP36 cannot output 1.75 V worth of signal above a rail it does not have.
    registerPart(manifestToPartDefinition(tmp36(), { supplyVolts: 1 }));
    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 't1', type: 'tmp36', x: 0, y: 60, props: { temperatureC: 125 } },
      ],
      wires: [
        { id: 'w2', from: 't1:GND', to: 'uno1:GND' },
        { id: 'w3', from: 't1:VOUT', to: 'uno1:A0' },
      ],
    });
    const { board } = buildCircuit(project, { progMem: loadHex(firmware('blink.hex')) });
    board.runFor(0.005);
    expect(board.voltage('A0')).toBeLessThanOrEqual(1.01);
  });
});

describe('rendering a generated part', () => {
  afterEach(() => {
    unregisterPart('neg-pins');
    unregisterPart('tiny');
  });

  /** Build a minimal manifest with the pin coordinates under test. */
  const withPins = (id: string, pins: [string, number, number][]) =>
    parseManifest({
      schemaVersion: 1,
      id,
      name: id,
      partNumber: id.toUpperCase(),
      category: 'passive',
      package: { type: 'TO-92', widthMm: 4.8, heightMm: 5.2, pinPitchMm: 1.27, bodyColor: '#2b2b2b' },
      pins: pins.map(([name, x, y]) => ({
        name,
        x,
        y,
        description: '',
        model: { kind: 'analog-in', impedanceOhms: 100000 },
      })),
      state: [],
      behavior: { kind: 'passive' },
      limits: {},
      provenance: { source: 'datasheet-ai', unresolved: [], verified: false },
    });

  it('gives every part an appearance, so the canvas can draw it', () => {
    // Without this a generated part renders as nothing at all and only its pin hit-targets appear,
    // which reads as a broken component rather than an unfamiliar one.
    const definition = manifestToPartDefinition(hcsr04());
    expect(definition.appearance).toBeDefined();
    expect(definition.appearance!.title).toBe('HC-SR04');
    expect(definition.appearance!.generated).toBe(false);
  });

  it('marks datasheet-extracted parts as generated', () => {
    const manifest = hcsr04();
    manifest.provenance.source = 'datasheet-ai';
    expect(manifestToPartDefinition(manifest).appearance!.generated).toBe(true);
  });

  it('shifts negative pin coordinates onto the body', () => {
    // Extraction frequently lays pins out around an origin rather than from a corner. Left alone
    // those pins draw outside the part, or off it entirely.
    const definition = manifestToPartDefinition(
      withPins('neg-pins', [['e', -2.54, -1.5], ['b', -1.27, -1.5], ['c', 0, -1.5]]),
    );

    for (const pin of definition.pins) {
      expect(pin.x, `${pin.name} x`).toBeGreaterThanOrEqual(0);
      expect(pin.y, `${pin.name} y`).toBeGreaterThanOrEqual(0);
      expect(pin.x).toBeLessThanOrEqual(definition.width);
      expect(pin.y).toBeLessThanOrEqual(definition.height);
    }
  });

  it('preserves the spacing between pins while shifting them', () => {
    // A shift must not distort the footprint: the pitch is what makes legs land in adjacent holes.
    const definition = manifestToPartDefinition(
      withPins('neg-pins', [['e', -2.54, -1.5], ['b', -1.27, -1.5], ['c', 0, -1.5]]),
    );
    const xs = definition.pins.map((p) => p.x);
    expect(xs[1]! - xs[0]!).toBeCloseTo(1.27, 6);
    expect(xs[2]! - xs[1]!).toBeCloseTo(1.27, 6);
  });

  it('leaves already-valid coordinates alone', () => {
    const definition = manifestToPartDefinition(
      withPins('neg-pins', [['a', 1, 1], ['b', 2.27, 1]]),
    );
    expect(definition.pins.map((p) => p.x)).toEqual([1, 2.27]);
  });

  it('grows the body when pins would overrun the stated package', () => {
    // A datasheet's mechanical drawing and its pin table do not always agree; the part still has
    // to be drawable.
    const definition = manifestToPartDefinition(
      withPins('tiny', [['a', 0, 0], ['b', 40, 0]]),
    );
    expect(definition.width).toBeGreaterThan(40);
  });

  it('never produces a body too small to see', () => {
    const definition = manifestToPartDefinition(withPins('tiny', [['a', 0, 0]]));
    expect(definition.width).toBeGreaterThanOrEqual(6);
    expect(definition.height).toBeGreaterThanOrEqual(6);
  });

  it('keeps the device wired to the shifted pins', () => {
    // The nodes are looked up by pin name, so normalisation must not break the electrical model.
    registerPart(
      manifestToPartDefinition(withPins('neg-pins', [['a', -5, -5], ['b', -2.46, -5]])),
    );
    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'x1', type: 'neg-pins', x: 0, y: 60 },
      ],
      wires: [{ id: 'w1', from: 'x1:a', to: 'uno1:A0' }],
    });
    const { problems } = buildCircuit(project, { progMem: loadHex(firmware('blink.hex')) });
    expect(problems).toEqual([]);
  });
});
