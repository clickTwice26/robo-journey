/**
 * Components that ship with the app, described the same way an extracted one is.
 *
 * Written as manifests rather than as hand-coded part definitions on purpose. Every one of these
 * goes through the identical path a datasheet extraction takes -- the same schema, the same
 * validator, the same runtime -- so the archetypes are exercised by the library itself rather than
 * only by whatever a user happens to feed the extractor. If a manifest cannot describe a 7805, the
 * tests say so before anyone tries it on a PDF.
 *
 * The numbers are datasheet-typical figures. Where a figure depends on something the datasheet
 * cannot know -- how much copper a regulator's tab is soldered to, above all -- the assumption is
 * recorded in `unresolved` rather than hidden in a default.
 */
import type { ComponentManifest } from './manifest.js';
import { manifestToPartDefinition } from './manifest-runtime.js';
import { registerPart, isRegistered } from './registry.js';

/**
 * The 7805, and the reason this archetype exists.
 *
 * Thermally it is the most misused part in hobby electronics: fed 12 V to make 5 V, it throws away
 * seven volts times whatever the load draws, and a bare TO-220 sheds about 65 degrees per watt. At
 * a quarter of an amp that is 1.75 W and 139 degrees -- inside its rating, but only just, and any
 * more shuts it down.
 */
const LM7805: ComponentManifest = {
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
  provenance: {
    source: 'builtin',
    unresolved: [
      'Thermal resistance is the 65 K/W free-air figure for a bare TO-220. On a heatsink it falls ' +
        'to around 5 K/W, which is the difference between shutting down and not.',
    ],
    verified: true,
  },
};

/** The AMS1117-3.3, the part on nearly every 3.3 V breakout -- and the reason so many sag. */
const AMS1117_33: ComponentManifest = {
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
  provenance: {
    source: 'builtin',
    unresolved: [
      'The 1.1 V dropout is the typical figure at full load; the datasheet allows up to 1.3 V. ' +
        'Either way a 3.3 V rail cannot be made from a 4 V supply with this part.',
      'Thermal resistance assumes the tab soldered to a minimal pad, which is what most breakout ' +
        'boards give it.',
    ],
    verified: true,
  },
};

/**
 * The 74HC595, and the one part where `stream` addressing is the whole point.
 *
 * It has no registers and no commands: bytes shift in on SCK and appear on the outputs when the
 * latch pin rises. Modelled with the latch as an active-low chip select, which is exactly how the
 * standard `digitalWrite(latch, LOW); SPI.transfer(x); digitalWrite(latch, HIGH)` idiom drives it,
 * so the byte lands when the latch closes and not before.
 */
const SHIFT_REGISTER_74HC595: ComponentManifest = {
  schemaVersion: 1,
  id: 'sn74hc595',
  name: '74HC595 Shift Register',
  manufacturer: 'Generic',
  partNumber: 'SN74HC595N',
  category: 'logic',
  description: '8-bit serial-in, parallel-out shift register with output latch.',
  package: { type: 'DIP-16', widthMm: 19.3, heightMm: 7.6, pinPitchMm: 2.54, bodyColor: '#1a1c20' },
  pins: [
    { name: 'QB', number: 1, x: 2.54, y: 0, description: 'Output 1', model: { kind: 'digital-out', impedanceOhms: 50, sourceMaxA: 0.035, sinkMaxA: 0.035, openDrain: false } },
    { name: 'QC', number: 2, x: 5.08, y: 0, description: 'Output 2', model: { kind: 'digital-out', impedanceOhms: 50, sourceMaxA: 0.035, sinkMaxA: 0.035, openDrain: false } },
    { name: 'QD', number: 3, x: 7.62, y: 0, description: 'Output 3', model: { kind: 'digital-out', impedanceOhms: 50, sourceMaxA: 0.035, sinkMaxA: 0.035, openDrain: false } },
    { name: 'QE', number: 4, x: 10.16, y: 0, description: 'Output 4', model: { kind: 'digital-out', impedanceOhms: 50, sourceMaxA: 0.035, sinkMaxA: 0.035, openDrain: false } },
    { name: 'QF', number: 5, x: 12.7, y: 0, description: 'Output 5', model: { kind: 'digital-out', impedanceOhms: 50, sourceMaxA: 0.035, sinkMaxA: 0.035, openDrain: false } },
    { name: 'QG', number: 6, x: 15.24, y: 0, description: 'Output 6', model: { kind: 'digital-out', impedanceOhms: 50, sourceMaxA: 0.035, sinkMaxA: 0.035, openDrain: false } },
    { name: 'QH', number: 7, x: 17.78, y: 0, description: 'Output 7', model: { kind: 'digital-out', impedanceOhms: 50, sourceMaxA: 0.035, sinkMaxA: 0.035, openDrain: false } },
    { name: 'GND', number: 8, x: 17.78, y: 7.62, description: 'Ground', model: { kind: 'ground' } },
    { name: 'QH*', number: 9, x: 15.24, y: 7.62, description: 'Serial out, for daisy-chaining', model: { kind: 'digital-out', impedanceOhms: 50, sourceMaxA: 0.035, sinkMaxA: 0.035, openDrain: false } },
    { name: 'SRCLR', number: 10, x: 12.7, y: 7.62, description: 'Shift register clear, active low', model: { kind: 'digital-in', vih: 3.15, vil: 1.35, impedanceOhms: 1e8, pull: 'none' } },
    { name: 'SRCLK', number: 11, x: 10.16, y: 7.62, description: 'Shift clock -- wire to SCK', model: { kind: 'digital-in', vih: 3.15, vil: 1.35, impedanceOhms: 1e8, pull: 'none' } },
    { name: 'RCLK', number: 12, x: 7.62, y: 7.62, description: 'Latch clock -- acts as chip select', model: { kind: 'digital-in', vih: 3.15, vil: 1.35, impedanceOhms: 1e8, pull: 'none' } },
    { name: 'OE', number: 13, x: 5.08, y: 7.62, description: 'Output enable, active low', model: { kind: 'digital-in', vih: 3.15, vil: 1.35, impedanceOhms: 1e8, pull: 'none' } },
    { name: 'SER', number: 14, x: 2.54, y: 7.62, description: 'Serial data in -- wire to MOSI', model: { kind: 'digital-in', vih: 3.15, vil: 1.35, impedanceOhms: 1e8, pull: 'none' } },
    { name: 'QA', number: 15, x: 0, y: 0, description: 'Output 0', model: { kind: 'digital-out', impedanceOhms: 50, sourceMaxA: 0.035, sinkMaxA: 0.035, openDrain: false } },
    { name: 'VCC', number: 16, x: 0, y: 7.62, description: 'Supply, 2 to 6 V', model: { kind: 'power', vNom: 5, vMin: 2, vMax: 6, iQuiescent: 8e-5 } },
  ],
  state: [],
  behavior: {
    kind: 'spi-peripheral',
    mosiPin: 'SER',
    misoPin: 'QH*',
    sckPin: 'SRCLK',
    csPin: 'RCLK',
    mode: 0,
    csActiveLow: true,
    bitOrder: 'msbFirst',
    maxClockHz: 20e6,
    addressing: 'stream',
    readBitPosition: 7,
    readBitValue: 1,
    autoIncrement: true,
    registers: [{ address: 0, name: 'OUTPUTS', reset: 0, access: 'rw', scale: 1, offset: 0, bytes: 1 }],
  },
  limits: { vccMaxVolts: 6, vccMinVolts: 2, pinMaxAmps: 0.035, totalMaxAmps: 0.07 },
  provenance: {
    source: 'builtin',
    unresolved: [
      'SRCLR and OE are modelled as ordinary inputs; the shift register always shifts and the ' +
        'outputs are always enabled, so tying them wrong will not be caught.',
    ],
    verified: true,
  },
};

/**
 * The ADXL345, chosen as the reference `register`-addressed SPI part.
 *
 * It also happens to be the best demonstration of why SPI mode is worth checking: it needs mode 3,
 * and the Arduino SPI library defaults to mode 0. Wired perfectly and clocked in the default mode
 * it returns nothing but zeros, which is a bug with no visible cause on a scope.
 */
const ADXL345: ComponentManifest = {
  schemaVersion: 1,
  id: 'adxl345',
  name: 'ADXL345 Accelerometer',
  manufacturer: 'Analog Devices',
  partNumber: 'ADXL345',
  category: 'sensor',
  description: '3-axis digital accelerometer, +/-16 g, SPI mode 3.',
  package: { type: 'module', widthMm: 15.2, heightMm: 20.3, pinPitchMm: 2.54, bodyColor: '#1e3a5f' },
  pins: [
    { name: 'VCC', number: 1, x: 2.54, y: 18, description: 'Supply, 2.0 to 3.6 V', model: { kind: 'power', vNom: 3.3, vMin: 2, vMax: 3.6, iQuiescent: 1.4e-4 } },
    { name: 'GND', number: 2, x: 5.08, y: 18, description: 'Ground', model: { kind: 'ground' } },
    { name: 'CS', number: 3, x: 7.62, y: 18, description: 'Chip select, active low', model: { kind: 'digital-in', vih: 2.31, vil: 0.99, impedanceOhms: 1e8, pull: 'none' } },
    { name: 'SDO', number: 4, x: 10.16, y: 18, description: 'Serial data out -- wire to MISO', model: { kind: 'digital-out', impedanceOhms: 50, sourceMaxA: 0.004, sinkMaxA: 0.004, openDrain: false } },
    { name: 'SDA', number: 5, x: 12.7, y: 18, description: 'Serial data in -- wire to MOSI', model: { kind: 'digital-in', vih: 2.31, vil: 0.99, impedanceOhms: 1e8, pull: 'none' } },
    { name: 'SCL', number: 6, x: 15.24, y: 18, description: 'Serial clock -- wire to SCK', model: { kind: 'digital-in', vih: 2.31, vil: 0.99, impedanceOhms: 1e8, pull: 'none' } },
  ],
  state: [
    { name: 'ax', label: 'X acceleration', unit: 'g', min: -16, max: 16, default: 0, step: 0.1 },
    { name: 'ay', label: 'Y acceleration', unit: 'g', min: -16, max: 16, default: 0, step: 0.1 },
    { name: 'az', label: 'Z acceleration', unit: 'g', min: -16, max: 16, default: 1, step: 0.1 },
  ],
  behavior: {
    kind: 'spi-peripheral',
    mosiPin: 'SDA',
    misoPin: 'SDO',
    sckPin: 'SCL',
    csPin: 'CS',
    mode: 3,
    csActiveLow: true,
    bitOrder: 'msbFirst',
    maxClockHz: 5e6,
    addressing: 'register',
    readBitPosition: 7,
    readBitValue: 1,
    autoIncrement: true,
    registers: [
      { address: 0x00, name: 'DEVID', reset: 0xe5, access: 'r', scale: 1, offset: 0, bytes: 1 },
      { address: 0x2d, name: 'POWER_CTL', reset: 0x00, access: 'rw', scale: 1, offset: 0, bytes: 1 },
      { address: 0x31, name: 'DATA_FORMAT', reset: 0x00, access: 'rw', scale: 1, offset: 0, bytes: 1 },
      // 3.9 mg per count in the default +/-2 g range, so 256 counts per g.
      { address: 0x32, name: 'DATAX', reset: 0, access: 'r', fromState: 'ax', scale: 256, offset: 0, bytes: 2 },
      { address: 0x34, name: 'DATAY', reset: 0, access: 'r', fromState: 'ay', scale: 256, offset: 0, bytes: 2 },
      { address: 0x36, name: 'DATAZ', reset: 0, access: 'r', fromState: 'az', scale: 256, offset: 0, bytes: 2 },
    ],
  },
  limits: { vccMaxVolts: 3.9, vccMinVolts: 2, pinMaxAmps: 0.01 },
  provenance: {
    source: 'builtin',
    unresolved: [
      'Acceleration registers are big-endian here; the real part is little-endian. Sketches using ' +
        'the standard library will read the axes byte-swapped.',
      'The measurement range is fixed at +/-2 g scaling regardless of what DATA_FORMAT is set to.',
    ],
    verified: true,
  },
};

/** Every manifest compiled into the app. */
export const BUILTIN_MANIFESTS: readonly ComponentManifest[] = [
  LM7805,
  AMS1117_33,
  SHIFT_REGISTER_74HC595,
  ADXL345,
];

/**
 * Put the built-in manifests into the registry.
 *
 * Idempotent, because the studio calls it at start-up and the tests call it per suite.
 */
export function installBuiltinManifests(): void {
  for (const manifest of BUILTIN_MANIFESTS) {
    if (isRegistered(manifest.id)) continue;
    registerPart(manifestToPartDefinition(manifest));
  }
}
