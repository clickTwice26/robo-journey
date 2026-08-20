/**
 * Supplies and regulators.
 *
 * The category the plan set out to make honest. A simulator that treats a battery as an ideal
 * source and a regulator as a perfect one will say yes to every power design ever drawn; the parts
 * here say no when the real ones would, and for the real reason -- not enough headroom, too much
 * dissipation, too much internal resistance.
 */
import type { ComponentManifest } from '../manifest.js';
import { PITCH, builtin, ground, power, row } from './kit.js';

const cell = (
  id: string,
  name: string,
  partNumber: string,
  volts: number,
  internalOhms: number,
  description: string,
  unresolved: string[],
): ComponentManifest => ({
  schemaVersion: 1,
  id,
  name,
  manufacturer: 'Generic',
  partNumber,
  category: 'power',
  description,
  package: { type: 'module', widthMm: 26, heightMm: 48, pinPitchMm: PITCH, bodyColor: '#2a2f38' },
  pins: row(
    [
      { name: '+', model: power(volts, { vNom: volts }), description: 'Positive terminal' },
      { name: '-', model: ground(), description: 'Negative terminal' },
    ],
    44,
  ),
  state: [],
  behavior: { kind: 'source', positivePin: '+', negativePin: '-', volts, internalOhms },
  limits: { vccMaxVolts: volts, vccMinVolts: volts },
  provenance: builtin([
    'State of charge is not modelled: the terminal voltage stays at the fresh figure indefinitely, ' +
      'and the pack never goes flat.',
    ...unresolved,
  ]),
});

/**
 * The 9 V alkaline, and the reason so many first robots do not move.
 *
 * Around 1.7 ohm internally when fresh, which is fine for a 20 mA circuit and hopeless for a motor:
 * pull half an amp and the terminal voltage has already fallen by most of a volt, before the
 * regulator downstream has taken its share.
 */
export const BATTERY_9V = cell(
  'battery-9v',
  '9 V Battery (alkaline)',
  '6LR61',
  9,
  1.7,
  'PP3 alkaline. Convenient, and the worst way to power anything that moves.',
  [
    'The 1.7 ohm figure is for a fresh cell. It rises steeply as the battery discharges, so a ' +
      'circuit that works on a new battery can fail on a half-used one.',
  ],
);

export const BATTERY_AA_4 = cell(
  'battery-aa-4',
  '4x AA Battery Pack',
  '4x LR6',
  6,
  0.6,
  'Four alkaline AA cells in series. 6 V, and stiff enough to run motors.',
  ['0.15 ohm per cell, four in series. NiMH rechargeables are lower still, and 4.8 V rather than 6.'],
);

export const LIPO_1S = cell(
  'lipo-1s',
  'LiPo Cell (1S)',
  '103450',
  3.7,
  0.09,
  'Single lithium-polymer cell, 3.7 V nominal. Very low internal resistance.',
  [
    'Nominal 3.7 V. A real cell runs 4.2 V charged down to 3.0 V empty, so a 3.3 V rail taken ' +
      'straight from it without a regulator will hold at first and fail later.',
  ],
);

export const USB_5V = cell(
  'usb-5v',
  'USB 5 V Supply',
  'USB-A charger',
  5,
  0.1,
  'Wall adapter or power bank. 5 V, and stiffer than any battery here.',
  [
    'The current limit is not enforced. A real charger folds back or shuts down past its rating, ' +
      'where this one will supply whatever the circuit asks for.',
  ],
);

/**
 * The 7805, and the reason the regulator archetype exists.
 *
 * Thermally it is the most misused part in hobby electronics: fed 12 V to make 5 V, it throws away
 * seven volts times whatever the load draws, and a bare TO-220 sheds about 65 degrees per watt. At
 * a quarter of an amp that is 1.75 W and 139 degrees -- inside its rating, but only just, and any
 * more shuts it down.
 */
export const LM7805: ComponentManifest = {
  schemaVersion: 1,
  id: 'lm7805',
  name: '7805 5 V Regulator',
  manufacturer: 'Generic',
  partNumber: 'L7805CV',
  category: 'power',
  description: 'Fixed 5 V linear regulator in TO-220. 1 A, 2 V dropout.',
  package: { type: 'TO-220', widthMm: 10.2, heightMm: 9.2, pinPitchMm: 2.54, bodyColor: '#22262c' },
  pins: [
    { name: 'IN', number: 1, x: 2.54, y: 8, description: 'Unregulated input', model: { kind: 'power', vNom: 9, vMin: 7, vMax: 35, iQuiescent: 0 } },
    { name: 'GND', number: 2, x: 5.08, y: 8, description: 'Ground and heat return', model: { kind: 'ground' } },
    { name: 'OUT', number: 3, x: 7.62, y: 8, description: 'Regulated 5 V output', model: { kind: 'analog-out', impedanceOhms: 0.02 } },
  ],
  state: [],
  behavior: {
    kind: 'regulator',
    inputPin: 'IN',
    outputPin: 'OUT',
    groundPin: 'GND',
    outputVolts: 5,
    dropoutVolts: 2,
    quiescentAmps: 5e-3,
    maxOutputAmps: 1,
    outputImpedanceOhms: 0.02,
    thermalOhmsPerWatt: 65,
    thermalShutdownC: 150,
    thermalMassJPerK: 0.9,
  },
  limits: { vccMaxVolts: 35, vccMinVolts: 7, totalMaxAmps: 1, operatingTempMinC: 0, operatingTempMaxC: 125 },
  provenance: builtin([
    'Thermal resistance is the 65 K/W free-air figure for a bare TO-220. On a heatsink it falls ' +
      'to around 5 K/W, which is the difference between shutting down and not.',
  ]),
};

/** The AMS1117-3.3, the part on nearly every 3.3 V breakout -- and the reason so many sag. */
export const AMS1117_33: ComponentManifest = {
  schemaVersion: 1,
  id: 'ams1117-33',
  name: 'AMS1117-3.3 Regulator',
  manufacturer: 'AMS',
  partNumber: 'AMS1117-3.3',
  category: 'power',
  description: 'Fixed 3.3 V LDO in SOT-223. 1 A, 1.1 V dropout.',
  package: { type: 'SOT-223', widthMm: 7.2, heightMm: 7, pinPitchMm: 2.3, bodyColor: '#1c1f24' },
  pins: [
    { name: 'GND', number: 1, x: 2.3, y: 6, description: 'Ground', model: { kind: 'ground' } },
    { name: 'OUT', number: 2, x: 4.6, y: 6, description: 'Regulated 3.3 V output', model: { kind: 'analog-out', impedanceOhms: 0.03 } },
    { name: 'IN', number: 3, x: 6.9, y: 6, description: 'Unregulated input', model: { kind: 'power', vNom: 5, vMin: 4.4, vMax: 15, iQuiescent: 0 } },
  ],
  state: [],
  behavior: {
    kind: 'regulator',
    inputPin: 'IN',
    outputPin: 'OUT',
    groundPin: 'GND',
    outputVolts: 3.3,
    dropoutVolts: 1.1,
    quiescentAmps: 5e-3,
    maxOutputAmps: 0.8,
    outputImpedanceOhms: 0.03,
    thermalOhmsPerWatt: 110,
    thermalShutdownC: 165,
    thermalMassJPerK: 0.15,
  },
  limits: { vccMaxVolts: 15, vccMinVolts: 4.4, totalMaxAmps: 0.8 },
  provenance: builtin([
    'The 1.1 V dropout is the typical figure at full load; the datasheet allows up to 1.3 V. ' +
      'Either way a 3.3 V rail cannot be made from a 4 V supply with this part.',
    'Thermal resistance assumes the tab soldered to a minimal pad, which is what most breakout ' +
      'boards give it.',
  ]),
};

/** The 7809, for the case a 12 V input has to become something a 5 V regulator can survive. */
export const LM7809: ComponentManifest = {
  schemaVersion: 1,
  id: 'lm7809',
  name: '7809 9 V Regulator',
  manufacturer: 'Generic',
  partNumber: 'L7809CV',
  category: 'power',
  description: 'Fixed 9 V linear regulator in TO-220. 1 A, 2 V dropout.',
  package: { type: 'TO-220', widthMm: 10.2, heightMm: 9.2, pinPitchMm: 2.54, bodyColor: '#22262c' },
  pins: [
    { name: 'IN', number: 1, x: 2.54, y: 8, description: 'Unregulated input', model: { kind: 'power', vNom: 12, vMin: 11, vMax: 35, iQuiescent: 0 } },
    { name: 'GND', number: 2, x: 5.08, y: 8, description: 'Ground and heat return', model: { kind: 'ground' } },
    { name: 'OUT', number: 3, x: 7.62, y: 8, description: 'Regulated 9 V output', model: { kind: 'analog-out', impedanceOhms: 0.02 } },
  ],
  state: [],
  behavior: {
    kind: 'regulator',
    inputPin: 'IN',
    outputPin: 'OUT',
    groundPin: 'GND',
    outputVolts: 9,
    dropoutVolts: 2,
    quiescentAmps: 5e-3,
    maxOutputAmps: 1,
    outputImpedanceOhms: 0.02,
    thermalOhmsPerWatt: 65,
    thermalShutdownC: 150,
    thermalMassJPerK: 0.9,
  },
  limits: { vccMaxVolts: 35, vccMinVolts: 11, totalMaxAmps: 1, operatingTempMinC: 0, operatingTempMaxC: 125 },
  provenance: builtin([
    'Thermal resistance is the bare TO-220 figure, as for the 7805.',
  ]),
};

export const POWER: readonly ComponentManifest[] = [
  BATTERY_9V,
  BATTERY_AA_4,
  LIPO_1S,
  USB_5V,
  LM7805,
  AMS1117_33,
  LM7809,
];
