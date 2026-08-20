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
import {
  Bjt,
  Circuit,
  GROUND,
  Led,
  Mosfet,
  Resistor,
  VoltageSource,
  digitalChannel,
  loadHex,
} from '@robo-journey/sim-core';
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

const BC547_DATASHEET = `
BC546/BC547/BC548 NPN General Purpose Amplifier

TO-92 package. Absolute maximum ratings (Ta = 25 C):
Collector-Base Voltage BC547: 50 V
Collector-Emitter Voltage BC547: 45 V
Emitter-Base Voltage: 6.0 V
Collector Current (DC): 100 mA
Power Dissipation: 625 mW
Operating and Storage Junction Temperature Range: -55 to +150 C

Electrical Characteristics (Ta = 25 C):
Collector-Emitter Saturation Voltage: 90 mV typ, 250 mV max at Ic = 10 mA, Ib = 0.5 mA
Base-Emitter On Voltage: 660 mV typ at Vce = 5 V, Ic = 2 mA
DC Current Gain hFE at Ic = 2 mA, Vce = 5 V:
  BC547A: 110 to 220
  BC547B: 200 to 450, typical 290
Transition Frequency: 300 MHz

Pin 1 = Emitter, Pin 2 = Base, Pin 3 = Collector (flat face toward you, left to right)
`;

const IRLZ44N_DATASHEET = `
IRLZ44N HEXFET Power MOSFET
N-Channel, Logic-Level Gate Drive

Absolute Maximum Ratings
VDSS = 55 V
RDS(on) = 0.022 Ohm (typical, VGS = 5.0 V)
ID = 47 A continuous drain current, VGS = 5.0 V, TC = 25 C
Power Dissipation = 110 W
Gate-to-Source Voltage VGS = +/- 16 V

Static @ TJ = 25 C
VGS(th)   Gate Threshold Voltage: 1.0 V min, 2.0 V max (VDS = VGS, ID = 250 uA)
RDS(on)   Static Drain-to-Source On-Resistance: 0.022 Ohm max (VGS = 5.0 V, ID = 25 A)
gfs       Forward Transconductance: 19 S min (VDS = 25 V, ID = 25 A)

Package: TO-220AB. Pin 1 = Gate, Pin 2 = Drain, Pin 3 = Source.
`;

const L7805_DATASHEET = `
L7805CV Positive Voltage Regulator
5 V fixed output, TO-220 package

Absolute Maximum Ratings
VI  DC Input Voltage: 35 V
IO  Output Current: internally limited, 1.5 A peak
PD  Power Dissipation: internally limited
TJ  Operating Junction Temperature: 0 to 125 C, thermal shutdown above 150 C

Thermal Data
RthJC  Thermal Resistance Junction-Case:    5 C/W
RthJA  Thermal Resistance Junction-Ambient: 50 C/W (TO-220, no heatsink)

Electrical Characteristics (TJ = 25 C, VI = 10 V, IO = 500 mA unless otherwise specified)
VO       Output Voltage:            4.8 V min, 5.0 V typ, 5.2 V max
VI - VO  Dropout Voltage:           2.0 V typ (IO = 1 A, TJ = 25 C)
IO       Output Current:            1.0 A guaranteed
Iq       Quiescent Current:         4.2 mA typ, 6 mA max
dVO      Load Regulation:           10 mV typ (IO = 5 mA to 1.5 A)
dVO      Line Regulation:           7 mV typ (VI = 7 V to 25 V)

Note: the input voltage must remain at least 2 V above the output for the device to regulate.

Package: TO-220. Pin 1 = INPUT, Pin 2 = GROUND (tab), Pin 3 = OUTPUT.
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
    'reads a BC547 into a transistor that actually switches',
    async () => {
      // Before the transistor archetype existed the model was forced into "passive" and said so
      // honestly in unresolved -- a part that drew correctly and did nothing. This checks it now
      // amplifies.
      const result = await extractManifest({
        apiKey,
        input: { kind: 'text', text: BC547_DATASHEET },
        hint: 'BC547 NPN transistor',
      });

      expect(result.ok).toBe(true);
      const manifest = result.manifest!;
      expect(validateManifest(manifest).ok).toBe(true);
      expect(manifest.behavior.kind).toBe('transistor');

      if (manifest.behavior.kind !== 'transistor') throw new Error('unexpected archetype');
      const behavior = manifest.behavior;
      expect(behavior.polarity).toBe('npn');
      // The datasheet's hFE, not a made-up number.
      expect(behavior.forwardBeta).toBeGreaterThan(100);
      expect(behavior.forwardBeta).toBeLessThan(900);

      registerPart(manifestToPartDefinition(manifest));
      try {
        // Common-emitter switch: weak base drive, LED in the collector leg.
        const circuit = new Circuit();
        const [supply, anode, collector, drive, base] = circuit.addNodes(5);
        circuit.add(new VoltageSource('VCC', supply!, GROUND, 5));
        const input = circuit.add(new VoltageSource('VIN', drive!, GROUND, 5));
        circuit.add(new Resistor('RB', drive!, base!, 10_000));
        circuit.add(new Resistor('RL', supply!, anode!, 150));
        const led = circuit.add(new Led('D1', anode!, collector!, 'red'));
        const q = circuit.add(
          new Bjt('Q1', collector!, base!, GROUND, behavior.polarity, {
            saturationCurrent: behavior.saturationCurrent,
            forwardBeta: behavior.forwardBeta,
            reverseBeta: behavior.reverseBeta,
            forwardEmission: 1,
            reverseEmission: 1,
          }),
        );

        circuit.solve();
        expect(led.brightness).toBeGreaterThan(0.5);
        // The point of a transistor: far more through the load than into the base.
        expect(led.current / q.baseCurrent).toBeGreaterThan(20);

        input.volts = 0;
        circuit.solve();
        expect(led.brightness).toBeLessThan(0.05);
      } finally {
        unregisterPart(manifest.id);
      }
    },
    120_000,
  );

  it(
    'reads a power MOSFET, including the milliohm conversion',
    async () => {
      const result = await extractManifest({
        apiKey,
        input: { kind: 'text', text: IRLZ44N_DATASHEET },
        hint: 'IRLZ44N logic-level N-channel MOSFET',
      });

      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      const manifest = result.manifest!;
      expect(validateManifest(manifest).ok).toBe(true);
      expect(manifest.behavior.kind).toBe('mosfet');

      if (manifest.behavior.kind !== 'mosfet') throw new Error('unexpected archetype');
      const behavior = manifest.behavior;
      expect(behavior.channel).toBe('n');

      // 22 mOhm is 0.022, and getting this wrong by a thousand turns a switch that drops
      // millivolts into one that drops volts.
      expect(behavior.rdsOnOhms).toBeGreaterThan(0.001);
      expect(behavior.rdsOnOhms).toBeLessThan(0.1);
      // Logic-level: the whole reason to choose this part.
      expect(behavior.thresholdVolts).toBeLessThan(2.5);

      // And it switches: 12 V across a 10 ohm load from a 5 V gate.
      const circuit = new Circuit();
      const [supply, drain, gate] = circuit.addNodes(3);
      circuit.add(new VoltageSource('VCC', supply!, GROUND, 12));
      circuit.add(new VoltageSource('VG', gate!, GROUND, 5));
      circuit.add(new Resistor('RL', supply!, drain!, 10));
      const q = circuit.add(
        new Mosfet('Q1', drain!, gate!, GROUND, behavior.channel, {
          threshold: behavior.thresholdVolts,
          k: behavior.k,
          lambda: behavior.lambda,
          rdsOn: behavior.rdsOnOhms,
          bodyDiode: { saturationCurrent: 1e-12, emissionCoefficient: 1.5, seriesResistance: 0.01 },
        }),
      );
      circuit.solve();

      expect(q.region).toBe('linear');
      expect(q.drainCurrent).toBeGreaterThan(1.1);
      // A properly-on power MOSFET drops a fraction of a volt, not volts.
      expect(Math.abs(q.vds)).toBeLessThan(0.5);
    },
    120_000,
  );

  it(
    'reads a 7805 into a regulator that drops out and overheats like the real part',
    async () => {
      const result = await extractManifest({
        apiKey,
        input: { kind: 'text', text: L7805_DATASHEET },
        hint: 'L7805CV fixed 5 V linear regulator',
      });

      expect(result.ok).toBe(true);
      const manifest = result.manifest!;
      expect(validateManifest(manifest).ok).toBe(true);

      // A regulator forced into "passive" would place on the canvas and regulate nothing, which is
      // the failure mode this archetype exists to prevent.
      expect(manifest.behavior.kind).toBe('regulator');
      if (manifest.behavior.kind !== 'regulator') return;
      const behavior = manifest.behavior;

      expect(behavior.outputVolts).toBeCloseTo(5, 1);
      // The number the whole archetype turns on. Read as anything else -- the input range, say --
      // and an under-powered design would simulate as working.
      expect(behavior.dropoutVolts).toBeGreaterThan(1.5);
      expect(behavior.dropoutVolts).toBeLessThan(3);
      // 4.2 mA, not 4.2 A.
      expect(behavior.quiescentAmps).toBeGreaterThan(1e-3);
      expect(behavior.quiescentAmps).toBeLessThan(0.02);
      // Junction-to-ambient, not the much smaller junction-to-case figure sitting next to it.
      expect(behavior.thermalOhmsPerWatt).toBeGreaterThan(20);

      registerPart(manifestToPartDefinition(manifest));
      try {
        const inPin = behavior.inputPin;
        const outPin = behavior.outputPin;
        const gndPin = behavior.groundPin;

        // 5 V in is not enough for a part needing 7 V, so it must sag rather than pretend.
        const project = parseProject({
          version: 1,
          parts: [
            { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
            { id: 'u1', type: manifest.id, x: 0, y: 80 },
            { id: 'r1', type: 'resistor', x: 40, y: 80, props: { ohms: 100 } },
          ],
          wires: [
            { id: 'w1', from: `u1:${inPin}`, to: 'uno1:5V' },
            { id: 'w2', from: `u1:${gndPin}`, to: 'uno1:GND' },
            { id: 'w3', from: `u1:${outPin}`, to: 'r1:a' },
            { id: 'w4', from: 'r1:b', to: 'uno1:GND' },
          ],
        });

        const { board, problems } = buildCircuit(project, { progMem: loadHex(firmware('blink.hex')) });
        expect(problems).toEqual([]);
        board.runFor(0.01);
        expect(board.faults.some((f) => f.code === 'regulator-dropout')).toBe(true);
      } finally {
        unregisterPart(manifest.id);
      }
    },
    180_000,
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
