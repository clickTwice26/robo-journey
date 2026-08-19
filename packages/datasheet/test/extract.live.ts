/**
 * Live extraction tests.
 *
 * These call Gemini and cost money, so they are excluded from the default suite and run with
 * `npm run test:live`. They skip themselves when GEMINI_API_KEY is not set, so a checkout without
 * a key still runs green.
 *
 * What they assert is deliberately narrow: not that the model produced one exact manifest, which
 * would be brittle, but that the *properties that make a manifest trustworthy* hold -- units
 * converted, archetype chosen correctly, assumptions declared, and the result actually simulating.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCircuit,
  manifestToPartDefinition,
  parseProject,
  registerPart,
  unregisterPart,
  validateManifest,
} from '@robo-journey/parts';
import { digitalChannel, loadHex } from '@robo-journey/sim-core';
import { extractManifest } from '../src/index.js';

const apiKey = process.env.GEMINI_API_KEY ?? '';
const describeIfKey = apiKey ? describe : describe.skip;

const HC_SR04_DATASHEET = `
HC-SR04 Ultrasonic Ranging Module

Product features:
Ultrasonic ranging module HC-SR04 provides 2cm - 400cm non-contact measurement function,
the ranging accuracy can reach to 3mm.

Electric Parameter
Working Voltage: DC 5 V
Working Current: 15 mA
Working Frequency: 40 Hz
Max Range: 4 m
Min Range: 2 cm
Dimension: 45 * 20 * 15 mm

Pin definition:
1 VCC  - 5V supply
2 Trig - Trigger pulse input
3 Echo - Echo pulse output
4 GND  - Ground

Timing:
You only need to supply a short 10uS pulse to the trigger input to start the ranging, and then the
module will send out an 8 cycle burst of ultrasound at 40 kHz and raise its echo.
Formula: uS / 58 = centimeters. We suggest to use over 60ms measurement cycle.
`;

const TMP36_DATASHEET = `
TMP36 Low Voltage Temperature Sensor

The TMP36 is a low voltage, precision centigrade temperature sensor. It provides a voltage output
that is linearly proportional to the Celsius temperature.

Specifications:
Supply Voltage: 2.7 V to 5.5 V
Supply Current: 50 uA maximum
Output Scale Factor: 10 mV/degC
Output Voltage at 25 degC: 750 mV
Offset Voltage: 500 mV at 0 degC
Temperature Range: -40 degC to +125 degC
Package: TO-92, 3 leads, 2.54 mm lead spacing

Pin 1 = +Vs, Pin 2 = Vout, Pin 3 = GND
`;

const firmware = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../sim-core/test/fixtures/${name}`, import.meta.url)), 'utf8');

describeIfKey('extracting from a datasheet', () => {
  it(
    'reads an HC-SR04 into a manifest that simulates correctly',
    async () => {
      const result = await extractManifest({
        apiKey,
        input: { kind: 'text', text: HC_SR04_DATASHEET },
        hint: 'HC-SR04 ultrasonic rangefinder',
      });

      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      const manifest = result.manifest!;

      // --- Structure ------------------------------------------------------------------------
      expect(validateManifest(manifest).ok).toBe(true);
      expect(manifest.category).toBe('sensor');
      expect(manifest.behavior.kind).toBe('pulse-echo');
      expect(manifest.pins).toHaveLength(4);

      // --- Units, the thing that goes wrong most often --------------------------------------
      if (manifest.behavior.kind === 'pulse-echo') {
        // "uS / 58 = centimeters" in seconds is 5.8e-5, not 58.
        expect(manifest.behavior.secondsPerUnit).toBeCloseTo(58e-6, 7);
        // "10uS pulse" in seconds is 1e-5, not 10.
        expect(manifest.behavior.minTriggerSeconds).toBeLessThan(1e-3);
      }
      // "15 mA" in amps is 0.015, not 15.
      const vcc = manifest.pins.find((p) => p.model.kind === 'power')!;
      if (vcc.model.kind === 'power') expect(vcc.model.iQuiescent).toBeLessThan(0.5);

      // --- Honesty ---------------------------------------------------------------------------
      // The datasheet gives no output impedance or echo latency, so a truthful extraction says so.
      expect(manifest.provenance.unresolved.length).toBeGreaterThan(0);
      expect(manifest.provenance.verified).toBe(false);
      expect(manifest.provenance.source).toBe('datasheet-ai');
      expect(manifest.provenance.model).toContain('prompt v');

      // --- It actually works -------------------------------------------------------------------
      registerPart(manifestToPartDefinition(manifest));
      try {
        const behavior = manifest.behavior;
        if (behavior.kind !== 'pulse-echo') throw new Error('unexpected archetype');
        const power = manifest.pins.find((p) => p.model.kind === 'power')!.name;
        const ground = manifest.pins.find((p) => p.model.kind === 'ground')!.name;

        const project = parseProject({
          version: 1,
          parts: [
            { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
            { id: 's1', type: manifest.id, x: 0, y: 60, props: { [behavior.state]: 40 } },
          ],
          wires: [
            { id: 'w1', from: `s1:${power}`, to: 'uno1:5V' },
            { id: 'w2', from: `s1:${ground}`, to: 'uno1:GND' },
            { id: 'w3', from: `s1:${behavior.triggerPin}`, to: 'uno1:D9' },
            { id: 'w4', from: `s1:${behavior.echoPin}`, to: 'uno1:D10' },
          ],
        });

        const { board, problems } = buildCircuit(project, { progMem: loadHex(firmware('sonar.hex')) });
        expect(problems).toEqual([]);
        board.runFor(0.3);

        const edges = board.recorder.edges(digitalChannel('D10'));
        const rise = edges.find((e) => e.level);
        const fall = edges.find((e) => !e.level && rise && e.time > rise.time);
        expect(rise, 'the generated component produced no echo pulse').toBeDefined();

        // 40 cm at 58 us/cm is 2320 us. This is the whole claim: a component described by a
        // language model, reading a datasheet, driving real firmware to the right answer.
        const widthMicros = (fall!.time - rise!.time) * 1e6;
        expect(widthMicros).toBeGreaterThan(2200);
        expect(widthMicros).toBeLessThan(2450);
      } finally {
        unregisterPart(manifest.id);
      }
    },
    120_000,
  );

  it(
    'reads a TMP36 into a working analog sensor',
    async () => {
      const result = await extractManifest({
        apiKey,
        input: { kind: 'text', text: TMP36_DATASHEET },
        hint: 'TMP36 analog temperature sensor',
      });

      expect(result.ok).toBe(true);
      const manifest = result.manifest!;
      expect(validateManifest(manifest).ok).toBe(true);
      expect(manifest.behavior.kind).toBe('analog-sensor');

      if (manifest.behavior.kind === 'analog-sensor') {
        // "10 mV/degC" in volts is 0.01, and the offset is 0.5 V -- so 25 C is 0.75 V.
        expect(manifest.behavior.voltsPerUnit).toBeCloseTo(0.01, 4);
        expect(manifest.behavior.offsetVolts).toBeCloseTo(0.5, 2);
      }

      registerPart(manifestToPartDefinition(manifest));
      try {
        const behavior = manifest.behavior;
        if (behavior.kind !== 'analog-sensor') throw new Error('unexpected archetype');
        const ground = manifest.pins.find((p) => p.model.kind === 'ground')!.name;

        const project = parseProject({
          version: 1,
          parts: [
            { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
            { id: 't1', type: manifest.id, x: 0, y: 60, props: { [behavior.state]: 25 } },
          ],
          wires: [
            { id: 'w1', from: `t1:${ground}`, to: 'uno1:GND' },
            { id: 'w2', from: `t1:${behavior.outputPin}`, to: 'uno1:A0' },
          ],
        });

        const { board } = buildCircuit(project, { progMem: loadHex(firmware('blink.hex')) });
        board.runFor(0.01);
        // The datasheet's own worked example: 750 mV at 25 C.
        expect(board.voltage('A0')).toBeCloseTo(0.75, 2);
      } finally {
        unregisterPart(manifest.id);
      }
    },
    120_000,
  );

  it(
    'is deterministic enough to be reproducible',
    async () => {
      // Temperature 0, so the same datasheet should give the same archetype and the same headline
      // numbers twice. A extraction that varied run to run could not be trusted or diffed.
      const runs = await Promise.all(
        [0, 1].map(() =>
          extractManifest({
            apiKey,
            input: { kind: 'text', text: TMP36_DATASHEET },
            hint: 'TMP36 analog temperature sensor',
          }),
        ),
      );

      expect(runs.every((r) => r.ok)).toBe(true);
      const [a, b] = runs.map((r) => r.manifest!);
      expect(a!.behavior.kind).toBe(b!.behavior.kind);
      expect(a!.pins.length).toBe(b!.pins.length);
    },
    180_000,
  );
});
