/**
 * The component library, in circuits rather than in the abstract.
 *
 * `builtin-manifests.test.ts` proves every manifest parses, validates and becomes a part. That is
 * not the same as proving the parts work: a manifest can be perfectly well formed and describe
 * something the engine quietly does nothing with. These tests wire the new archetypes up and read
 * the result off the solver, which is the only evidence that counts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type Led, loadHex } from '@robo-journey/sim-core';
import {
  BUILTIN_MANIFESTS,
  buildCircuit,
  builtinParts,
  installBuiltinManifests,
  parseProject,
  unregisterPart,
} from '../src/index.js';

const firmware = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../sim-core/test/fixtures/${name}`, import.meta.url)), 'utf8');

const blink = () => loadHex(firmware('blink.hex'));

afterEach(() => {
  for (const manifest of BUILTIN_MANIFESTS) unregisterPart(manifest.id);
});

describe('the library', () => {
  it('gives every part a unique id, including the hand-written ones', () => {
    // A collision would silently shadow one part with another, and the loser would simply never
    // appear in the palette.
    const ids = [...builtinParts().map((p) => p.type), ...BUILTIN_MANIFESTS.map((m) => m.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every category a project needs', () => {
    const categories = new Set(BUILTIN_MANIFESTS.map((m) => m.category));
    for (const wanted of ['sensor', 'actuator', 'display', 'power', 'logic', 'passive']) {
      expect(categories).toContain(wanted);
    }
  });

  it('says what it could not model, part by part', () => {
    // The unresolved list is the honesty mechanism. A display that accepts pixels and draws none,
    // a relay whose contacts do not switch -- those are fine to ship and not fine to hide.
    for (const manifest of BUILTIN_MANIFESTS) {
      const behaviour = manifest.behavior.kind;
      if (behaviour !== 'i2c-peripheral' && behaviour !== 'spi-peripheral') continue;
      expect(manifest.provenance.unresolved.length).toBeGreaterThan(0);
    }
  });
});

describe('a battery', () => {
  function batteryProject(loadOhms: number) {
    installBuiltinManifests();
    return parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'bat', type: 'battery-9v', x: 0, y: 80 },
        { id: 'r1', type: 'resistor', x: 40, y: 80, props: { ohms: loadOhms } },
      ],
      wires: [
        { id: 'w1', from: 'bat:+', to: 'r1:a' },
        { id: 'w2', from: 'r1:b', to: 'bat:-' },
        { id: 'w3', from: 'bat:-', to: 'uno1:GND' },
      ],
    });
  }

  it('sits at its nominal voltage when nothing is drawing', () => {
    const { board, nodes, problems } = buildCircuit(batteryProject(1e6), { progMem: blink() });
    expect(problems).toEqual([]);
    board.runFor(0.001);
    expect(board.circuit.voltage(nodes.get('bat:+')!)).toBeCloseTo(9, 2);
  });

  it('sags under load, which is the only reason to model one', () => {
    // 9 V behind 1.7 ohm into 10 ohm is a divider: 9 * 10/11.7 = 7.69 V. An ideal source would
    // hold 9 V here and every battery-powered design would look fine.
    const { board, nodes } = buildCircuit(batteryProject(10), { progMem: blink() });
    board.runFor(0.001);
    expect(board.circuit.voltage(nodes.get('bat:+')!)).toBeCloseTo(7.69, 1);
  });
});

describe('a 7805 fed from a battery', () => {
  /** The circuit the regulator archetype was written for, and which had no supply to run on. */
  function suppliedRegulator(loadOhms: number) {
    installBuiltinManifests();
    return parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'bat', type: 'battery-9v', x: 0, y: 80 },
        { id: 'u1', type: 'lm7805', x: 40, y: 80 },
        { id: 'r1', type: 'resistor', x: 80, y: 80, props: { ohms: loadOhms } },
      ],
      wires: [
        { id: 'w1', from: 'bat:+', to: 'u1:IN' },
        { id: 'w2', from: 'bat:-', to: 'u1:GND' },
        { id: 'w3', from: 'u1:GND', to: 'uno1:GND' },
        { id: 'w4', from: 'u1:OUT', to: 'r1:a' },
        { id: 'w5', from: 'r1:b', to: 'u1:GND' },
      ],
    });
  }

  it('regulates, now that it has the headroom', () => {
    const { board, nodes, problems } = buildCircuit(suppliedRegulator(1000), { progMem: blink() });
    expect(problems).toEqual([]);
    board.runFor(0.01);

    expect(board.circuit.voltage(nodes.get('u1:OUT')!)).toBeCloseTo(5, 1);
    expect(board.faults.map((f) => f.code)).not.toContain('regulator-dropout');
  });

  it('pulls the battery down as the load grows, and keeps regulating anyway', () => {
    // 5 V across 7 ohm is 714 mA, and 714 mA through the battery's 1.7 ohm costs 1.2 V before the
    // regulator sees any of it. The input sags; the output does not, which is the entire job.
    //
    // Thermal shutdown is real here too and takes about a minute of simulated time to arrive --
    // the thermal time constant is 58 s -- so it is proved at the device level in
    // `sim-core/test/regulator.test.ts` rather than by running the MCU for a minute.
    const { board, nodes } = buildCircuit(suppliedRegulator(7), { progMem: blink() });
    board.runFor(0.01);

    expect(board.circuit.voltage(nodes.get('u1:IN')!)).toBeLessThan(8);
    expect(board.circuit.voltage(nodes.get('u1:OUT')!)).toBeCloseTo(5, 1);
  });
});

describe('an RGB LED', () => {
  it('lights the channel that is driven', () => {
    installBuiltinManifests();
    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'rgb', type: 'rgb-led', x: 0, y: 80 },
        { id: 'r1', type: 'resistor', x: 40, y: 80, props: { ohms: 220 } },
      ],
      wires: [
        { id: 'w1', from: 'uno1:D13', to: 'r1:a' },
        { id: 'w2', from: 'r1:b', to: 'rgb:R' },
        { id: 'w3', from: 'rgb:COM', to: 'uno1:GND' },
      ],
    });

    const { board, devices, problems } = buildCircuit(project, { progMem: blink() });
    expect(problems).toEqual([]);

    // Blink holds D13 high for half a second at a time.
    board.runFor(0.3);
    const red = devices.get('rgb') as Led;
    expect(red.brightness).toBeGreaterThan(0.5);
  });
});

describe('a motor on a pin', () => {
  it('draws far more than the pin can give, and the fault says so', () => {
    // The mistake every kit makes at least once. 8 ohm across 5 V is 625 mA from a pin rated 40.
    installBuiltinManifests();
    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'm1', type: 'dc-motor', x: 0, y: 80 },
      ],
      wires: [
        { id: 'w1', from: 'uno1:D13', to: 'm1:M1' },
        { id: 'w2', from: 'm1:M2', to: 'uno1:GND' },
      ],
    });

    const { board } = buildCircuit(project, { progMem: blink() });
    board.runFor(0.3);

    expect(board.faults.map((f) => f.code)).toContain('pin-over-current');
  });
});

describe('an ADS1115 on the bus', () => {
  it('answers the scan and returns the conversion the user set', () => {
    // The stock I2C fixture reads two bytes from register 0 at address 0x48, which is exactly the
    // ADS1115's conversion register -- so the sketch is a real driver, not a test harness.
    installBuiltinManifests();
    const project = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'adc', type: 'ads1115', x: 0, y: 80, props: { volts: 1 } },
      ],
      wires: [
        { id: 'w1', from: 'adc:VDD', to: 'uno1:5V' },
        { id: 'w2', from: 'adc:GND', to: 'uno1:GND' },
        { id: 'w3', from: 'adc:SDA', to: 'uno1:A4' },
        { id: 'w4', from: 'adc:SCL', to: 'uno1:A5' },
      ],
    });

    const { board, problems } = buildCircuit(project, { progMem: loadHex(firmware('i2c.hex')) });
    expect(problems).toEqual([]);

    let text = '';
    board.mcu.onSerialByte((byte) => {
      text += String.fromCharCode(byte);
    });
    board.runFor(0.4);

    expect(text).toContain('0x48');
    // 8000 counts per volt at the default +/-4.096 V range.
    expect(text).toContain('t=8000');
  });
});
