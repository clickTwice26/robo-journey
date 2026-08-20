/**
 * Sensors.
 *
 * Every one of these declares the quantity it senses as a state variable, because a sensor with
 * nothing to sense senses nothing forever. The UI turns each into a control, which is how a
 * simulated rangefinder gets told there is a wall 40 cm away.
 *
 * Ranges are the ones the real part covers, taken from its specification table rather than chosen
 * to be round -- a thermistor that reads to 300 C in simulation and 125 C on the bench teaches the
 * wrong thing.
 */
import type { ComponentManifest } from '../manifest.js';
import { analogIn, analogOut, builtin, digitalIn, digitalOut, ground, headerModule, PITCH, power, row } from './kit.js';

export const PHOTORESISTOR: ComponentManifest = {
  schemaVersion: 1,
  id: 'photoresistor',
  name: 'Photoresistor (LDR)',
  manufacturer: 'Generic',
  partNumber: 'GL5528',
  category: 'sensor',
  description: 'Light-dependent resistor. Megohms in the dark, a few kilohms in daylight.',
  package: { type: 'radial', widthMm: 8, heightMm: 7, pinPitchMm: PITCH, bodyColor: '#2b2f36' },
  pins: row(
    [
      { name: 'A', model: analogIn(1e9) },
      { name: 'B', model: analogIn(1e9) },
    ],
    5,
  ),
  state: [{
      name: 'lux',
      label: 'Light',
      unit: 'lux',
      min: 0,
      max: 1000,
      default: 100,
      step: 1,
      quantity: 'light',
      // A cell in a package only sees what is in front of it. No range: light is what arrives.
      fieldOfViewDeg: 120,
    }],
  behavior: {
    kind: 'variable-resistor',
    pinA: 'A',
    pinB: 'B',
    state: 'lux',
    // Interpolated logarithmically, which is how photoresistors actually behave: the decade from
    // 1 to 10 lux moves the resistance as much as the decade from 100 to 1000.
    ohmsAtMin: 1_000_000,
    ohmsAtMax: 1_000,
  },
  limits: { pinMaxAmps: 0.02 },
  provenance: builtin([
    'Light history is not modelled. A real cell takes seconds to recover from bright light, which ' +
      'matters for anything sampling faster than that.',
  ]),
};

export const THERMISTOR_10K: ComponentManifest = {
  schemaVersion: 1,
  id: 'thermistor-10k',
  name: '10k NTC Thermistor',
  manufacturer: 'Generic',
  partNumber: 'NTC 10k B3950',
  category: 'sensor',
  description: 'Negative-coefficient thermistor. 10 kohm at 25 C, falling as it warms.',
  package: { type: 'radial', widthMm: 7, heightMm: 6, pinPitchMm: PITCH, bodyColor: '#1c2430' },
  pins: row(
    [
      { name: 'A', model: analogIn(1e9) },
      { name: 'B', model: analogIn(1e9) },
    ],
    4.5,
  ),
  state: [
    { name: 'temperatureC', label: 'Temperature', unit: 'C', min: -20, max: 120, default: 25, step: 1, quantity: 'temperature' },
  ],
  behavior: {
    kind: 'variable-resistor',
    pinA: 'A',
    pinB: 'B',
    state: 'temperatureC',
    // Endpoints from the B3950 curve: about 100 kohm at -20 C, about 500 ohm at 120 C.
    ohmsAtMin: 97_000,
    ohmsAtMax: 500,
  },
  limits: { pinMaxAmps: 0.01, operatingTempMinC: -40, operatingTempMaxC: 125 },
  provenance: builtin([
    'Log interpolation between the endpoints, not the Steinhart-Hart equation. Close in the middle ' +
      'of the range and a few degrees out at the extremes.',
  ]),
};

export const TMP36: ComponentManifest = {
  schemaVersion: 1,
  id: 'tmp36',
  name: 'TMP36 Temperature Sensor',
  manufacturer: 'Analog Devices',
  partNumber: 'TMP36GT9',
  category: 'sensor',
  description: 'Analog temperature sensor. 10 mV per degree, 500 mV at 0 C.',
  package: { type: 'TO-92', widthMm: 8, heightMm: 8, pinPitchMm: PITCH, bodyColor: '#22262c' },
  pins: row(
    [
      { name: 'VS', model: power(5, { vMin: 2.7, vMax: 5.5, iQuiescent: 5e-5 }), description: 'Supply' },
      { name: 'VOUT', model: analogOut(100), description: 'Output' },
      { name: 'GND', model: ground(), description: 'Ground' },
    ],
    5.5,
  ),
  state: [
    { name: 'temperatureC', label: 'Temperature', unit: 'C', min: -40, max: 125, default: 25, step: 1, quantity: 'temperature' },
  ],
  behavior: {
    kind: 'analog-sensor',
    outputPin: 'VOUT',
    state: 'temperatureC',
    voltsPerUnit: 0.01,
    // The offset is what lets it read below freezing on a single supply, and what everyone forgets
    // to subtract.
    offsetVolts: 0.5,
    clampToSupply: true,
  },
  limits: { vccMaxVolts: 5.5, vccMinVolts: 2.7, pinMaxAmps: 0.05 },
  provenance: builtin([]),
};

export const LM35: ComponentManifest = {
  schemaVersion: 1,
  id: 'lm35',
  name: 'LM35 Temperature Sensor',
  manufacturer: 'Texas Instruments',
  partNumber: 'LM35DZ',
  category: 'sensor',
  description: 'Analog temperature sensor. 10 mV per degree, no offset.',
  package: { type: 'TO-92', widthMm: 8, heightMm: 8, pinPitchMm: PITCH, bodyColor: '#22262c' },
  pins: row(
    [
      { name: 'VS', model: power(5, { vMin: 4, vMax: 30, iQuiescent: 6e-5 }), description: 'Supply' },
      { name: 'VOUT', model: analogOut(100), description: 'Output' },
      { name: 'GND', model: ground(), description: 'Ground' },
    ],
    5.5,
  ),
  state: [
    { name: 'temperatureC', label: 'Temperature', unit: 'C', min: 0, max: 100, default: 25, step: 1, quantity: 'temperature' },
  ],
  behavior: {
    kind: 'analog-sensor',
    outputPin: 'VOUT',
    state: 'temperatureC',
    voltsPerUnit: 0.01,
    offsetVolts: 0,
    clampToSupply: true,
  },
  limits: { vccMaxVolts: 30, vccMinVolts: 4, pinMaxAmps: 0.01 },
  provenance: builtin([
    'No offset means it cannot read below zero on a single supply. The range is set to 0 C for ' +
      'that reason rather than to the part\'s own -55 C minimum.',
  ]),
};

export const HC_SR04: ComponentManifest = {
  schemaVersion: 1,
  id: 'hc-sr04',
  name: 'HC-SR04 Ultrasonic Rangefinder',
  manufacturer: 'Generic',
  partNumber: 'HC-SR04',
  category: 'sensor',
  description: 'Trigger-and-echo rangefinder. 2 cm to 4 m.',
  package: headerModule(4, 20, '#1d3f6e'),
  pins: row(
    [
      { name: 'VCC', model: power(5, { vMin: 4.5, vMax: 5.5, iQuiescent: 0.015 }), description: 'Supply' },
      { name: 'TRIG', model: digitalIn(5), description: 'Trigger input' },
      { name: 'ECHO', model: digitalOut({ sourceMaxA: 0.008, sinkMaxA: 0.008 }), description: 'Echo output' },
      { name: 'GND', model: ground(), description: 'Ground' },
    ],
    17,
  ),
  state: [{
      name: 'distanceCm',
      label: 'Distance',
      unit: 'cm',
      min: 2,
      max: 400,
      default: 40,
      step: 1,
      quantity: 'distance',
      // Four metres and a fifteen degree cone: the figures on the module's own datasheet, and
      // the reason it misses a wall a foot to one side.
      rangeCm: 400,
      fieldOfViewDeg: 15,
    }],
  behavior: {
    kind: 'pulse-echo',
    triggerPin: 'TRIG',
    echoPin: 'ECHO',
    state: 'distanceCm',
    minTriggerSeconds: 10e-6,
    responseDelaySeconds: 460e-6,
    // 58 microseconds per centimetre: sound out and back at 343 m/s.
    secondsPerUnit: 58e-6,
    timeoutSeconds: 38e-3,
  },
  limits: { vccMaxVolts: 5.5, vccMinVolts: 4.5, pinMaxAmps: 0.02 },
  provenance: builtin([
    'The ECHO pin is 5 V. On a 3.3 V board it needs a divider, and nothing here will stop you ' +
      'wiring it straight to a pin.',
  ]),
};

export const PIR_HC_SR501: ComponentManifest = {
  schemaVersion: 1,
  id: 'hc-sr501',
  name: 'HC-SR501 PIR Motion Sensor',
  manufacturer: 'Generic',
  partNumber: 'HC-SR501',
  category: 'sensor',
  description: 'Passive infrared motion detector. Output goes high while it sees movement.',
  package: headerModule(3, 24, '#2d1f3f'),
  pins: row(
    [
      { name: 'VCC', model: power(5, { vMin: 4.5, vMax: 20, iQuiescent: 5e-5 }), description: 'Supply' },
      { name: 'OUT', model: digitalOut({ sourceMaxA: 0.01, sinkMaxA: 0.01 }), description: 'Motion output' },
      { name: 'GND', model: ground(), description: 'Ground' },
    ],
    20,
  ),
  state: [{
      name: 'motion',
      label: 'Movement in view',
      unit: '',
      min: 0,
      max: 1,
      default: 0,
      step: 1,
      quantity: 'motion',
      rangeCm: 700,
      // A wide cone, which is why a PIR aimed at a doorway also sees most of the room.
      fieldOfViewDeg: 110,
    }],
  behavior: {
    kind: 'threshold-switch',
    outputPin: 'OUT',
    state: 'motion',
    threshold: 0.5,
    // Active high, unlike most modules -- which is why so many sketches written for a different
    // sensor read it inverted.
    activeLow: false,
    hysteresis: 0,
  },
  limits: { vccMaxVolts: 20, vccMinVolts: 4.5, pinMaxAmps: 0.02 },
  provenance: builtin([
    'The retrigger timer and sensitivity trimmers are not modelled: the output follows the ' +
      'movement input directly, where a real one holds high for seconds afterwards.',
  ]),
};

export const HALL_A3144: ComponentManifest = {
  schemaVersion: 1,
  id: 'a3144',
  name: 'A3144 Hall Effect Sensor',
  manufacturer: 'Allegro',
  partNumber: 'A3144',
  category: 'sensor',
  description: 'Digital hall switch. Output pulls low near a magnet. Open drain.',
  package: { type: 'TO-92', widthMm: 8, heightMm: 8, pinPitchMm: PITCH, bodyColor: '#22262c' },
  pins: row(
    [
      { name: 'VCC', model: power(5, { vMin: 4.5, vMax: 24, iQuiescent: 9e-3 }), description: 'Supply' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'OUT', model: digitalOut({ openDrain: true, sinkMaxA: 0.025 }), description: 'Open-drain output' },
    ],
    5.5,
  ),
  state: [{ name: 'magnet', label: 'Magnet present', unit: '', min: 0, max: 1, default: 0, step: 1, quantity: 'magnet' }],
  behavior: {
    kind: 'threshold-switch',
    outputPin: 'OUT',
    state: 'magnet',
    threshold: 0.5,
    activeLow: true,
    hysteresis: 0,
  },
  limits: { vccMaxVolts: 24, vccMinVolts: 4.5, pinMaxAmps: 0.025 },
  provenance: builtin([
    'Open drain, so it needs a pull-up -- either a resistor or the pin\'s own. Without one it ' +
      'never reads high and looks like a dead sensor.',
    'Unipolar: it responds to one magnetic pole only. Flipping the magnet does nothing.',
  ]),
};

export const REED_SWITCH: ComponentManifest = {
  schemaVersion: 1,
  id: 'reed-switch',
  name: 'Reed Switch Module',
  manufacturer: 'Generic',
  partNumber: 'KY-025',
  category: 'sensor',
  description: 'Magnetic contact switch. The usual door and window sensor.',
  package: headerModule(3, 15, '#233041'),
  pins: row(
    [
      { name: 'VCC', model: power(5, { vMin: 3.3, vMax: 5.5, iQuiescent: 5e-3 }), description: 'Supply' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'DO', model: digitalOut({ sourceMaxA: 0.01, sinkMaxA: 0.01 }), description: 'Digital output' },
    ],
    12,
  ),
  state: [{ name: 'magnet', label: 'Magnet near', unit: '', min: 0, max: 1, default: 0, step: 1, quantity: 'magnet' }],
  behavior: {
    kind: 'threshold-switch',
    outputPin: 'DO',
    state: 'magnet',
    threshold: 0.5,
    activeLow: true,
    hysteresis: 0,
  },
  limits: { vccMaxVolts: 5.5, vccMinVolts: 3.3, pinMaxAmps: 0.02 },
  provenance: builtin(['Contact bounce is not modelled; a real reed switch chatters for a millisecond or two.']),
};

export const SOIL_MOISTURE: ComponentManifest = {
  schemaVersion: 1,
  id: 'soil-moisture',
  name: 'Soil Moisture Sensor',
  manufacturer: 'Generic',
  partNumber: 'Capacitive v1.2',
  category: 'sensor',
  description: 'Capacitive moisture probe. Output falls as the soil gets wetter.',
  package: headerModule(3, 40, '#2a3d1f'),
  pins: row(
    [
      { name: 'VCC', model: power(5, { vMin: 3.3, vMax: 5.5, iQuiescent: 5e-3 }), description: 'Supply' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'AOUT', model: analogOut(1000), description: 'Analog output' },
    ],
    36,
  ),
  state: [{ name: 'moisture', label: 'Moisture', unit: '%', min: 0, max: 100, default: 40, step: 1, quantity: 'moisture' }],
  behavior: {
    kind: 'analog-sensor',
    outputPin: 'AOUT',
    state: 'moisture',
    // Inverted: dry reads high, wet reads low. Getting this backwards is the single most common
    // mistake with these boards.
    voltsPerUnit: -0.019,
    offsetVolts: 2.9,
    clampToSupply: true,
  },
  limits: { vccMaxVolts: 5.5, vccMinVolts: 3.3, pinMaxAmps: 0.01 },
  provenance: builtin([
    'The transfer curve is a straight line fitted between dry and submerged. A real probe is ' +
      'noticeably curved and drifts with soil salinity.',
  ]),
};

export const MQ2_GAS: ComponentManifest = {
  schemaVersion: 1,
  id: 'mq2',
  name: 'MQ-2 Gas Sensor',
  manufacturer: 'Generic',
  partNumber: 'MQ-2',
  category: 'sensor',
  description: 'Combustible gas and smoke sensor. Output rises with concentration.',
  package: headerModule(4, 22, '#3d2a1f'),
  pins: row(
    [
      { name: 'VCC', model: power(5, { vMin: 4.9, vMax: 5.1, iQuiescent: 0.15 }), description: 'Supply, heater included' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'AOUT', model: analogOut(1000), description: 'Analog output' },
      { name: 'DOUT', model: digitalOut({ sourceMaxA: 0.01, sinkMaxA: 0.01 }), description: 'Threshold output' },
    ],
    18,
  ),
  state: [{ name: 'ppm', label: 'Gas', unit: 'ppm', min: 200, max: 10000, default: 400, step: 50, quantity: 'gas' }],
  behavior: {
    kind: 'analog-sensor',
    outputPin: 'AOUT',
    state: 'ppm',
    voltsPerUnit: 0.0004,
    offsetVolts: 0.4,
    clampToSupply: true,
  },
  limits: { vccMaxVolts: 5.1, vccMinVolts: 4.9, totalMaxAmps: 0.2 },
  provenance: builtin([
    'The heater draws 150 mA continuously, which is most of what a USB-powered board has to spare.',
    'A real MQ-2 needs 24-48 hours of burn-in and is not calibrated in ppm without a reference gas.',
  ]),
};

/**
 * Infrared flame sensor.
 *
 * The photodiode with the black lens that comes in every starter kit. It responds to the infrared
 * a flame gives off, over a cone of about sixty degrees, and it is fooled by sunlight and by
 * incandescent bulbs for exactly the same reason it works at all -- both are full of infrared.
 */
export const FLAME_SENSOR: ComponentManifest = {
  schemaVersion: 1,
  id: 'flame-sensor',
  name: 'Flame Sensor (IR)',
  manufacturer: 'Generic',
  partNumber: 'KY-026',
  category: 'sensor',
  description: 'Infrared flame detector. Analog output rises as the fire gets closer.',
  package: headerModule(4, 15, '#3d1f1f'),
  pins: row(
    [
      { name: 'VCC', model: power(5, { vMin: 3.3, vMax: 5.5, iQuiescent: 0.015 }), description: 'Supply' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'AOUT', model: analogOut(1000), description: 'Analog output' },
      { name: 'DOUT', model: digitalOut({ sourceMaxA: 0.01, sinkMaxA: 0.01 }), description: 'Threshold output' },
    ],
    11,
  ),
  state: [
    {
      name: 'flame',
      label: 'Flame',
      unit: '',
      min: 0,
      max: 1,
      default: 0,
      step: 0.01,
      quantity: 'flame',
      rangeCm: 100,
      fieldOfViewDeg: 60,
    },
  ],
  behavior: {
    kind: 'analog-sensor',
    outputPin: 'AOUT',
    state: 'flame',
    voltsPerUnit: 4.5,
    offsetVolts: 0.2,
    clampToSupply: true,
  },
  limits: { vccMaxVolts: 5.5, vccMinVolts: 3.3, pinMaxAmps: 0.01 },
  provenance: builtin([
    'DOUT is declared but not driven; the comparator and its trim pot are not modelled, so use ' +
      'AOUT and compare in the sketch.',
    'A real one cannot tell a flame from sunlight or a filament lamp. Here it responds only to a ' +
      'flame, which makes it easier to work with and less honest about where it fails.',
  ]),
};

/**
 * Microphone module.
 *
 * Sound level, not sound. The analog output follows how loud it is, which is all these modules
 * really give you -- they are envelope detectors, and any sketch trying to read a waveform off one
 * is reading noise.
 */
export const SOUND_SENSOR: ComponentManifest = {
  schemaVersion: 1,
  id: 'sound-sensor',
  name: 'Sound Sensor (microphone)',
  manufacturer: 'Generic',
  partNumber: 'KY-038',
  category: 'sensor',
  description: 'Electret microphone with an amplifier. Analog output tracks loudness.',
  package: headerModule(4, 15, '#2a2a35'),
  pins: row(
    [
      { name: 'VCC', model: power(5, { vMin: 3.3, vMax: 5.5, iQuiescent: 0.005 }), description: 'Supply' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'AOUT', model: analogOut(1000), description: 'Analog output' },
      { name: 'DOUT', model: digitalOut({ sourceMaxA: 0.01, sinkMaxA: 0.01 }), description: 'Threshold output' },
    ],
    11,
  ),
  state: [
    {
      name: 'soundDb',
      label: 'Sound level',
      unit: 'dB',
      min: 30,
      max: 110,
      default: 40,
      step: 1,
      quantity: 'sound',
      // No cone: an electret capsule is close enough to omnidirectional to model as one.
      rangeCm: 500,
    },
  ],
  behavior: {
    kind: 'analog-sensor',
    outputPin: 'AOUT',
    state: 'soundDb',
    // Quiet room to a shout across the ADC's range: 30 dB reads near zero, 110 dB near the rail.
    voltsPerUnit: 0.055,
    offsetVolts: -1.5,
    clampToSupply: true,
  },
  limits: { vccMaxVolts: 5.5, vccMinVolts: 3.3, pinMaxAmps: 0.01 },
  provenance: builtin([
    'The output is a level, not a waveform. Frequency is not modelled at all, so a sketch cannot ' +
      'tell a whistle from a shout of the same loudness.',
    'DOUT is declared but not driven; the on-board comparator is not modelled.',
  ]),
};

/**
 * Vibration sensor.
 *
 * A spring inside a tube: shake it and the spring touches the wall, closing the contact. Which is
 * why it detects a knock beautifully and a steady tilt not at all.
 */
export const VIBRATION_SENSOR: ComponentManifest = {
  schemaVersion: 1,
  id: 'vibration-sensor',
  name: 'Vibration Sensor',
  manufacturer: 'Generic',
  partNumber: 'SW-420',
  category: 'sensor',
  description: 'Spring vibration switch. Output changes while it is being shaken.',
  package: headerModule(3, 15, '#2f2a1f'),
  pins: row(
    [
      { name: 'VCC', model: power(5, { vMin: 3.3, vMax: 5.5, iQuiescent: 0.015 }), description: 'Supply' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'DO', model: digitalOut({ sourceMaxA: 0.01, sinkMaxA: 0.01 }), description: 'Digital output' },
    ],
    11,
  ),
  state: [
    { name: 'shake', label: 'Vibration', unit: '', min: 0, max: 1, default: 0, step: 0.01, quantity: 'vibration' },
  ],
  behavior: {
    kind: 'threshold-switch',
    outputPin: 'DO',
    state: 'shake',
    threshold: 0.35,
    activeLow: true,
    // A real spring rattles; without hysteresis the output would chatter on every solve near the
    // threshold and a sketch counting edges would count nonsense.
    hysteresis: 0.1,
  },
  limits: { vccMaxVolts: 5.5, vccMinVolts: 3.3, pinMaxAmps: 0.02 },
  provenance: builtin([
    'The output follows the vibration level directly. A real SW-420 produces a burst of ragged ' +
      'pulses while it is shaken, which is why sketches for it count edges over a window rather ' +
      'than reading the pin once.',
  ]),
};

export const SENSORS: readonly ComponentManifest[] = [
  PHOTORESISTOR,
  THERMISTOR_10K,
  TMP36,
  LM35,
  HC_SR04,
  PIR_HC_SR501,
  HALL_A3144,
  REED_SWITCH,
  SOIL_MOISTURE,
  MQ2_GAS,
  FLAME_SENSOR,
  SOUND_SENSOR,
  VIBRATION_SENSOR,
];
