/**
 * The parts that end up in every circuit: diodes, transistors, capacitors, a pot, an op-amp.
 *
 * Every figure is a datasheet typical rather than a limit. A transistor's minimum hFE is what the
 * manufacturer guarantees, not what the part in your hand does, and simulating with the minimum
 * makes every bias calculation pessimistic in a way that does not match the bench.
 */
import type { ComponentManifest } from '../manifest.js';
import { analogIn, analogOut, builtin, dip, ground, notConnected, PITCH, power, row } from './kit.js';

const DIODE_BODY = { type: 'DO-41', widthMm: 9, heightMm: 6, pinPitchMm: PITCH, bodyColor: '#2a2f36' };

export const DIODE_1N4148: ComponentManifest = {
  schemaVersion: 1,
  id: '1n4148',
  name: '1N4148 Signal Diode',
  manufacturer: 'Generic',
  partNumber: '1N4148',
  category: 'passive',
  description: 'Fast small-signal silicon diode. 100 V, 200 mA, ~0.7 V forward.',
  package: { ...DIODE_BODY, type: 'DO-35', widthMm: 8, bodyColor: '#3a3f47' },
  pins: row(
    [
      { name: 'A', model: analogIn(1e9), description: 'Anode' },
      { name: 'K', model: analogOut(0.5), description: 'Cathode, the banded end' },
    ],
    3,
  ),
  state: [],
  behavior: {
    kind: 'diode',
    anodePin: 'A',
    cathodePin: 'K',
    saturationCurrent: 2.52e-9,
    emissionCoefficient: 1.75,
    seriesResistanceOhms: 0.568,
  },
  limits: { vccMaxVolts: 100, pinMaxAmps: 0.2 },
  provenance: builtin([
    'Reverse recovery is not modelled, so this behaves the same as a slow rectifier in a ' +
      'switching circuit -- which is the one place the difference matters.',
  ]),
};

export const DIODE_1N4007: ComponentManifest = {
  schemaVersion: 1,
  id: '1n4007',
  name: '1N4007 Rectifier Diode',
  manufacturer: 'Generic',
  partNumber: '1N4007',
  category: 'passive',
  description: 'Mains-rated rectifier. 1000 V, 1 A. The usual flyback diode across a relay coil.',
  package: DIODE_BODY,
  pins: row(
    [
      { name: 'A', model: analogIn(1e9), description: 'Anode' },
      { name: 'K', model: analogOut(0.5), description: 'Cathode, the banded end' },
    ],
    3,
  ),
  state: [],
  behavior: {
    kind: 'diode',
    anodePin: 'A',
    cathodePin: 'K',
    // A rectifier drops noticeably more than a signal diode, and under load more again -- which is
    // the whole reason the two are not interchangeable.
    saturationCurrent: 1.4e-8,
    emissionCoefficient: 1.98,
    seriesResistanceOhms: 0.035,
  },
  limits: { vccMaxVolts: 1000, pinMaxAmps: 1 },
  provenance: builtin([]),
};

const to92 = (names: [string, string, string], descriptions: [string, string, string]) =>
  row(
    names.map((name, i) => ({ name, model: analogIn(1e9), description: descriptions[i]! })),
    5.5,
  );

export const BJT_2N2222: ComponentManifest = {
  schemaVersion: 1,
  id: '2n2222',
  name: '2N2222 NPN Transistor',
  manufacturer: 'Generic',
  partNumber: 'P2N2222A',
  category: 'passive',
  description: 'General-purpose NPN switch. 40 V, 800 mA, hFE ~200.',
  package: { type: 'TO-92', widthMm: 8, heightMm: 8, pinPitchMm: PITCH, bodyColor: '#22262c' },
  pins: to92(['E', 'B', 'C'], ['Emitter', 'Base', 'Collector']),
  state: [],
  behavior: {
    kind: 'transistor',
    polarity: 'npn',
    collectorPin: 'C',
    basePin: 'B',
    emitterPin: 'E',
    forwardBeta: 200,
    reverseBeta: 4,
    saturationCurrent: 1e-14,
  },
  limits: { vccMaxVolts: 40, pinMaxAmps: 0.8 },
  provenance: builtin([
    'hFE is the typical figure. The datasheet guarantees 100 minimum, and a design that only ' +
      'works at 200 is a design that works on some parts.',
  ]),
};

export const BJT_BC547: ComponentManifest = {
  schemaVersion: 1,
  id: 'bc547',
  name: 'BC547 NPN Transistor',
  manufacturer: 'Generic',
  partNumber: 'BC547B',
  category: 'passive',
  description: 'Small-signal NPN. 45 V, 100 mA, hFE ~300.',
  package: { type: 'TO-92', widthMm: 8, heightMm: 8, pinPitchMm: PITCH, bodyColor: '#22262c' },
  // Not the same order as a 2N2222, which is exactly how a working circuit becomes a hot
  // transistor when one is swapped for the other.
  pins: to92(['C', 'B', 'E'], ['Collector', 'Base', 'Emitter']),
  state: [],
  behavior: {
    kind: 'transistor',
    polarity: 'npn',
    collectorPin: 'C',
    basePin: 'B',
    emitterPin: 'E',
    forwardBeta: 300,
    reverseBeta: 4,
    saturationCurrent: 1e-14,
  },
  limits: { vccMaxVolts: 45, pinMaxAmps: 0.1 },
  provenance: builtin(['Pinout is C-B-E, the reverse of a 2N2222 seen from the same side.']),
};

export const BJT_2N3904: ComponentManifest = {
  schemaVersion: 1,
  id: '2n3904',
  name: '2N3904 NPN Transistor',
  manufacturer: 'Generic',
  partNumber: '2N3904',
  category: 'passive',
  description: 'Small-signal NPN. 40 V, 200 mA, hFE ~150.',
  package: { type: 'TO-92', widthMm: 8, heightMm: 8, pinPitchMm: PITCH, bodyColor: '#22262c' },
  pins: to92(['E', 'B', 'C'], ['Emitter', 'Base', 'Collector']),
  state: [],
  behavior: {
    kind: 'transistor',
    polarity: 'npn',
    collectorPin: 'C',
    basePin: 'B',
    emitterPin: 'E',
    forwardBeta: 150,
    reverseBeta: 4,
    saturationCurrent: 6.7e-15,
  },
  limits: { vccMaxVolts: 40, pinMaxAmps: 0.2 },
  provenance: builtin([]),
};

export const MOSFET_2N7000: ComponentManifest = {
  schemaVersion: 1,
  id: '2n7000',
  name: '2N7000 N-Channel MOSFET',
  manufacturer: 'Generic',
  partNumber: '2N7000',
  category: 'passive',
  description: 'Small logic-level MOSFET. 60 V, 200 mA, RDS(on) ~5 ohm.',
  package: { type: 'TO-92', widthMm: 8, heightMm: 8, pinPitchMm: PITCH, bodyColor: '#22262c' },
  pins: to92(['S', 'G', 'D'], ['Source', 'Gate', 'Drain']),
  state: [],
  behavior: {
    kind: 'mosfet',
    channel: 'n',
    drainPin: 'D',
    gatePin: 'G',
    sourcePin: 'S',
    thresholdVolts: 2.1,
    // From the datasheet's Id at a stated Vgs: k = 2*Id/(Vgs - Vth)^2.
    k: 0.5,
    rdsOnOhms: 5,
    lambda: 0.02,
  },
  limits: { vccMaxVolts: 60, pinMaxAmps: 0.2 },
  provenance: builtin([
    'Five ohms on-resistance is high enough to matter: at 200 mA it drops a volt and dissipates ' +
      '200 mW, which is most of what this package can shed.',
  ]),
};

export const MOSFET_IRLZ44N: ComponentManifest = {
  schemaVersion: 1,
  id: 'irlz44n',
  name: 'IRLZ44N Power MOSFET',
  manufacturer: 'Infineon',
  partNumber: 'IRLZ44N',
  category: 'passive',
  description: 'Logic-level N-channel power MOSFET. 55 V, 47 A, RDS(on) 22 mohm.',
  package: { type: 'TO-220', widthMm: 10.2, heightMm: 9.2, pinPitchMm: PITCH, bodyColor: '#22262c' },
  pins: row(
    [
      { name: 'G', model: analogIn(1e9), description: 'Gate' },
      { name: 'D', model: analogIn(1e9), description: 'Drain, also the tab' },
      { name: 'S', model: analogIn(1e9), description: 'Source' },
    ],
    8,
  ),
  state: [],
  behavior: {
    kind: 'mosfet',
    channel: 'n',
    drainPin: 'D',
    gatePin: 'G',
    sourcePin: 'S',
    thresholdVolts: 1.5,
    k: 4.082,
    // 22 milliohms. Written as 0.022 rather than 22, which is the unit slip that makes a power
    // MOSFET simulate as a resistor.
    rdsOnOhms: 0.022,
    lambda: 0.02,
  },
  limits: { vccMaxVolts: 55, pinMaxAmps: 47 },
  provenance: builtin([
    'Logic-level, so 5 V from an Arduino pin genuinely turns it on. A plain IRF540 in the same ' +
      'package needs 10 V and will run hot on a 5 V gate.',
  ]),
};

export const OPAMP_LM358: ComponentManifest = {
  schemaVersion: 1,
  id: 'lm358',
  name: 'LM358 Dual Op-Amp',
  manufacturer: 'Generic',
  partNumber: 'LM358N',
  category: 'passive',
  description: 'Single-supply dual op-amp in DIP-8. The default comparator and buffer.',
  package: { type: 'DIP-8', widthMm: 10.2, heightMm: 7.62, pinPitchMm: PITCH, bodyColor: '#1a1c20' },
  pins: dip(
    [
      { name: 'OUT1', model: analogOut(100), description: 'Output, amplifier A' },
      { name: 'IN1-', model: analogIn(1e9), description: 'Inverting input, A' },
      { name: 'IN1+', model: analogIn(1e9), description: 'Non-inverting input, A' },
      { name: 'GND', model: ground(), description: 'Negative supply, pin 4' },
      { name: 'IN2+', model: notConnected(), description: 'Non-inverting input, B' },
      { name: 'IN2-', model: notConnected(), description: 'Inverting input, B' },
      { name: 'OUT2', model: notConnected(), description: 'Output, amplifier B' },
      { name: 'VCC', model: power(5, { vMin: 3, vMax: 32, iQuiescent: 7e-4 }), description: 'Positive supply, pin 8' },
    ],
    7.62,
  ),
  state: [],
  behavior: {
    kind: 'op-amp',
    nonInvertingPin: 'IN1+',
    invertingPin: 'IN1-',
    outputPin: 'OUT1',
    positiveRailPin: 'VCC',
    negativeRailPin: 'GND',
    openLoopGain: 100_000,
    outputImpedanceOhms: 100,
    inputImpedanceOhms: 1e9,
    // The number that decides whether a single-supply circuit works. An LM358 cannot get within
    // about 1.5 V of its positive rail, which is why so many textbook circuits built with one
    // behave nothing like the textbook.
    headroomHighVolts: 1.5,
    headroomLowVolts: 0.02,
  },
  limits: { vccMaxVolts: 32, vccMinVolts: 3, pinMaxAmps: 0.04 },
  provenance: builtin([
    'Only amplifier A is simulated. The B pins are present so the package wires correctly, but ' +
      'nothing is connected behind them.',
  ]),
};

export const CAP_CERAMIC_100N: ComponentManifest = {
  schemaVersion: 1,
  id: 'cap-100nf',
  name: '100 nF Ceramic Capacitor',
  manufacturer: 'Generic',
  partNumber: '104',
  category: 'passive',
  description: 'The decoupling capacitor that belongs beside every IC supply pin.',
  package: { type: 'radial', widthMm: 6, heightMm: 6, pinPitchMm: PITCH, bodyColor: '#3d4a2a' },
  pins: row(
    [
      { name: 'A', model: analogIn(1e12) },
      { name: 'B', model: analogIn(1e12) },
    ],
    4,
  ),
  state: [],
  behavior: { kind: 'capacitor', pinA: 'A', pinB: 'B', farads: 100e-9, ratedVolts: 50, polarised: false },
  limits: { vccMaxVolts: 50 },
  provenance: builtin([
    'Equivalent series resistance and inductance are not modelled, and above a few megahertz ' +
      'those are most of what a real decoupling capacitor does.',
  ]),
};

export const CAP_ELECTROLYTIC_100U: ComponentManifest = {
  schemaVersion: 1,
  id: 'cap-100uf',
  name: '100 uF Electrolytic Capacitor',
  manufacturer: 'Generic',
  partNumber: '100uF 25V',
  category: 'passive',
  description: 'Bulk smoothing across a supply. Polarised -- backwards is destructive.',
  package: { type: 'radial', widthMm: 8, heightMm: 8, pinPitchMm: PITCH, bodyColor: '#1c2430' },
  pins: row(
    [
      { name: '+', model: analogIn(1e10), description: 'Positive, the long leg' },
      { name: '-', model: analogIn(1e10), description: 'Negative, the striped side' },
    ],
    5.5,
  ),
  state: [],
  behavior: { kind: 'capacitor', pinA: '+', pinB: '-', farads: 100e-6, ratedVolts: 25, polarised: true },
  limits: { vccMaxVolts: 25 },
  provenance: builtin([
    'Reverse polarity is recorded but not enforced: connecting this backwards ruins the real part ' +
      'and simulates perfectly happily.',
  ]),
};

export const POT_10K: ComponentManifest = {
  schemaVersion: 1,
  id: 'potentiometer-10k',
  name: '10k Potentiometer',
  manufacturer: 'Generic',
  partNumber: 'RV09',
  category: 'sensor',
  description: 'Three-terminal 10k pot. A divider whose wiper is where the knob is.',
  package: { type: 'trimmer', widthMm: 10, heightMm: 9, pinPitchMm: PITCH, bodyColor: '#1f2937' },
  pins: row(
    [
      { name: 'A', model: analogIn(1e9), description: 'One end of the track' },
      { name: 'W', model: analogOut(1), description: 'Wiper' },
      { name: 'B', model: analogIn(1e9), description: 'The other end' },
    ],
    7,
  ),
  state: [{ name: 'position', label: 'Knob', unit: '', min: 0, max: 1, default: 0.5, step: 0.01 }],
  behavior: {
    kind: 'potentiometer',
    terminalAPin: 'A',
    wiperPin: 'W',
    terminalBPin: 'B',
    totalOhms: 10_000,
    taper: 'linear',
    state: 'position',
  },
  limits: { pinMaxAmps: 0.05 },
  provenance: builtin([]),
};

export const DISCRETES: readonly ComponentManifest[] = [
  DIODE_1N4148,
  DIODE_1N4007,
  BJT_2N2222,
  BJT_BC547,
  BJT_2N3904,
  MOSFET_2N7000,
  MOSFET_IRLZ44N,
  OPAMP_LM358,
  CAP_CERAMIC_100N,
  CAP_ELECTROLYTIC_100U,
  POT_10K,
];
