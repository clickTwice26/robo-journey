/**
 * The manifests that ship with the app.
 *
 * They exist to be useful in the palette, but they earn their place in the test suite for a
 * different reason: each one is a worked example of an archetype, run through the same schema,
 * validator and runtime an extracted part takes. A regulator archetype that cannot describe a 7805
 * is not an archetype, and this is where that would be found out.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHex } from '@robo-journey/sim-core';
import {
  BUILTIN_MANIFESTS,
  buildCircuit,
  installBuiltinManifests,
  manifestToPartDefinition,
  parseManifest,
  parseProject,
  unregisterPart,
  validateManifest,
} from '../src/index.js';

const firmware = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../sim-core/test/fixtures/${name}`, import.meta.url)), 'utf8');

const blink = () => loadHex(firmware('blink.hex'));

afterEach(() => {
  for (const manifest of BUILTIN_MANIFESTS) unregisterPart(manifest.id);
});

describe('built-in manifests', () => {
  it.each(BUILTIN_MANIFESTS.map((m) => [m.id, m] as const))('%s parses against the schema', (_id, manifest) => {
    expect(() => parseManifest(manifest)).not.toThrow();
  });

  it.each(BUILTIN_MANIFESTS.map((m) => [m.id, m] as const))('%s validates without errors', (_id, manifest) => {
    const result = validateManifest(manifest);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each(BUILTIN_MANIFESTS.map((m) => [m.id, m] as const))('%s becomes a usable part', (_id, manifest) => {
    const definition = manifestToPartDefinition(manifest);
    expect(definition.type).toBe(manifest.id);
    expect(definition.pins).toHaveLength(manifest.pins.length);
    // Every pin has to land inside the body, or it draws outside the part on the canvas.
    for (const pin of definition.pins) {
      expect(pin.x).toBeGreaterThanOrEqual(0);
      expect(pin.y).toBeGreaterThanOrEqual(0);
      expect(pin.x).toBeLessThanOrEqual(definition.width);
      expect(pin.y).toBeLessThanOrEqual(definition.height);
    }
  });

  it('records what it had to assume', () => {
    // Built in is not the same as beyond question. A thermal resistance depends on how much copper
    // the part is soldered to, which no datasheet can know, and saying so is the difference between
    // a number and a guess wearing a number's clothes.
    const regulator = BUILTIN_MANIFESTS.find((m) => m.id === 'lm7805')!;
    expect(regulator.provenance.unresolved.join(' ')).toMatch(/heatsink|thermal/i);
  });

  it('installs idempotently', () => {
    installBuiltinManifests();
    expect(() => installBuiltinManifests()).not.toThrow();
  });
});

describe('a 7805 in a circuit', () => {
  /** Regulator fed from VIN, output feeding a resistive load. */
  function regulatorProject(loadOhms: number) {
    installBuiltinManifests();
    return parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'u1', type: 'lm7805', x: 0, y: 80 },
        { id: 'r1', type: 'resistor', x: 40, y: 80, props: { ohms: loadOhms } },
      ],
      wires: [
        { id: 'w1', from: 'u1:IN', to: 'uno1:5V' },
        { id: 'w2', from: 'u1:GND', to: 'uno1:GND' },
        { id: 'w3', from: 'u1:OUT', to: 'r1:a' },
        { id: 'w4', from: 'r1:b', to: 'uno1:GND' },
      ],
    });
  }

  it('builds without complaint', () => {
    const { problems } = buildCircuit(regulatorProject(1000), { progMem: blink() });
    expect(problems).toEqual([]);
  });

  it('cannot regulate 5 V from a 5 V rail, and says why', () => {
    // Fed from the Uno's own 5 V, a 7805 has none of its 2 V of headroom. Simulators that model a
    // regulator as an ideal source show this working; the bench shows about 3 V.
    const { board } = buildCircuit(regulatorProject(1000), { progMem: blink() });
    board.runFor(0.01);

    const fault = board.faults.find((f) => f.code === 'regulator-dropout');
    expect(fault).toBeDefined();
    expect(fault!.message).toContain('7.00 V');
  });
});

describe('an SPI part from a manifest', () => {
  it('attaches itself to the bus and answers', () => {
    installBuiltinManifests();
    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'a1', type: 'adxl345', x: 0, y: 80, props: { az: 1 } },
      ],
      wires: [
        { id: 'w1', from: 'a1:VCC', to: 'uno1:3V3' },
        { id: 'w2', from: 'a1:GND', to: 'uno1:GND' },
        { id: 'w3', from: 'a1:CS', to: 'uno1:D9' },
        { id: 'w4', from: 'a1:SDO', to: 'uno1:D12' },
        { id: 'w5', from: 'a1:SDA', to: 'uno1:D11' },
        { id: 'w6', from: 'a1:SCL', to: 'uno1:D13' },
      ],
    });

    const { board, problems } = buildCircuit(project, { progMem: loadHex(firmware('spi.hex')) });
    expect(problems).toEqual([]);

    let text = '';
    board.mcu.onSerialByte((byte) => {
      text += String.fromCharCode(byte);
    });
    board.runFor(0.3);

    // The manifest's own DEVID register, reached through the compiled sketch and a chip-select
    // pin the sketch drove itself.
    expect(text).toContain('id=E5');
  });

  it('needs a bus to attach to', () => {
    // The failure has to be loud. A part that silently never answered would look like a wiring
    // problem, and someone would spend an evening on it.
    const definition = manifestToPartDefinition(
      BUILTIN_MANIFESTS.find((m) => m.id === 'adxl345')!,
    );
    expect(() =>
      definition.build!({
        partId: 'a1',
        props: {},
        node: () => 0,
        add: () => {},
      }),
    ).toThrow(/SPI bus/);
  });
});
