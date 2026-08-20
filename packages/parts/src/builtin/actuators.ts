/**
 * Actuators.
 *
 * The category where the interesting failure is almost always electrical rather than logical. A
 * servo, a motor and a relay coil each draw more than an Arduino pin can give, and the sketch
 * driving them is usually correct -- what fails is the supply. So the numbers that matter most
 * here are the current figures, and they are the ones the simulator can act on: a stalled motor
 * across a pin pulls the rail down and trips the brown-out detector, exactly as it does on the
 * bench.
 */
import type { ComponentManifest } from '../manifest.js';
import { PITCH, builtin, digitalIn, ground, internal, led, power, row } from './kit.js';

export const SERVO_SG90: ComponentManifest = {
  schemaVersion: 1,
  id: 'sg90',
  name: 'SG90 Micro Servo',
  manufacturer: 'TowerPro',
  partNumber: 'SG90',
  category: 'actuator',
  description: '9 g hobby servo, 180 degrees. Position follows the pulse width.',
  package: { type: 'module', widthMm: 23, heightMm: 12.2, pinPitchMm: PITCH, bodyColor: '#4a4f57' },
  pins: row(
    [
      { name: 'GND', model: ground(), description: 'Ground, brown wire' },
      { name: 'VCC', model: power(5, { vMin: 4.8, vMax: 6, iQuiescent: 0.006 }), description: 'Supply, red wire' },
      { name: 'SIG', model: digitalIn(5), description: 'Pulse input, orange wire' },
    ],
    9,
  ),
  state: [],
  behavior: {
    kind: 'pwm-actuator',
    signalPin: 'SIG',
    minPulseSeconds: 1e-3,
    maxPulseSeconds: 2e-3,
    minPosition: 0,
    maxPosition: 180,
    // About 0.1 s per 60 degrees at 5 V, which is 600 deg/s unloaded. Derated for a real load.
    slewPerSecond: 400,
    // The number that matters. Two of these on a USB-powered Uno is a brown-out waiting for the
    // moment they both move.
    movingCurrentA: 0.55,
    holdCurrentA: 0.01,
  },
  limits: { vccMaxVolts: 6, vccMinVolts: 4.8, totalMaxAmps: 0.7 },
  provenance: builtin([
    'Stall current is around 700 mA and is not modelled separately; a blocked horn draws the ' +
      'moving figure, not the stall figure.',
    'The Arduino Servo library uses a 20 ms frame, which is what the pulse-echo timings assume.',
  ]),
};

export const BUZZER_ACTIVE: ComponentManifest = {
  schemaVersion: 1,
  id: 'buzzer-active',
  name: 'Active Buzzer',
  manufacturer: 'Generic',
  partNumber: 'HYT-1205',
  category: 'actuator',
  description: 'Buzzer with its own oscillator. Apply voltage, it sounds. One tone only.',
  package: { type: 'radial', widthMm: 12, heightMm: 9.5, pinPitchMm: PITCH, bodyColor: '#101216' },
  pins: row(
    [
      // A 60 ohm load between the terminals: real, and enough to over-current a pin driving it
      // directly, which is what an active buzzer wired straight to a GPIO does.
      { name: '+', model: internal('-', { ohms: 60 }), description: 'Positive terminal' },
      { name: '-', model: ground(), description: 'Negative terminal' },
    ],
    7,
  ),
  state: [
    // Not a quantity the world supplies -- nothing on the canvas makes a buzzer louder -- so these
    // carry no `quantity` and stay under the user's control. What they do drive is the sound this
    // buzzer *emits*, which a microphone module across the bench will hear.
    { name: 'volumeDb', label: 'Loudness', unit: 'dB', min: 40, max: 100, default: 85, step: 1 },
    { name: 'frequencyHz', label: 'Tone', unit: 'Hz', min: 1000, max: 4000, default: 2300, step: 50 },
  ],
  behavior: { kind: 'passive' },
  limits: { vccMaxVolts: 5.5, pinMaxAmps: 0.09 },
  provenance: builtin([
    'Nothing is played through your speakers. The buzzer emits into the simulated workspace, so a ' +
      'sound sensor nearby will hear it; there is no audio.',
    'The tone is adjustable here. On a real active buzzer it is fixed by the internal oscillator ' +
      'and about 2.3 kHz, whatever you would like it to be.',
  ]),
};

export const BUZZER_PASSIVE: ComponentManifest = {
  schemaVersion: 1,
  id: 'buzzer-passive',
  name: 'Piezo Buzzer (passive)',
  manufacturer: 'Generic',
  partNumber: 'Piezo disc',
  category: 'actuator',
  description: 'Bare piezo element. Needs a square wave -- this is what tone() drives.',
  package: { type: 'radial', widthMm: 12, heightMm: 9.5, pinPitchMm: PITCH, bodyColor: '#3a3018' },
  pins: row(
    [
      { name: '+', model: { kind: 'analog-in', impedanceOhms: 1e8 }, description: 'Positive terminal' },
      { name: '-', model: ground(), description: 'Negative terminal' },
    ],
    7,
  ),
  state: [
    { name: 'volumeDb', label: 'Loudness', unit: 'dB', min: 40, max: 95, default: 75, step: 1 },
  ],
  // A piezo element genuinely is a capacitor -- around 20 nF -- and modelling it as one is not an
  // approximation. It is also why a passive buzzer draws current only on the edges, and why it is
  // safe on a pin where the active one is not.
  behavior: { kind: 'capacitor', pinA: '+', pinB: '-', farads: 20e-9, polarised: false },
  limits: { vccMaxVolts: 12, pinMaxAmps: 0.02 },
  provenance: builtin([
    'Nothing is played through your speakers. It emits into the simulated workspace so a sound ' +
      'sensor can hear it; there is no audio.',
    'There is no tone property because there is no tone to set: the pitch is whatever the sketch ' +
      'drives the pin at, which is the entire difference between this and the active one.',
    'The mechanical resonance that decides how loud a given frequency comes out is not modelled, ' +
      'so loudness is the figure you set rather than one that peaks near 2 kHz as a real disc does.',
  ]),
};

export const DC_MOTOR: ComponentManifest = {
  schemaVersion: 1,
  id: 'dc-motor',
  name: 'DC Motor (small)',
  manufacturer: 'Generic',
  partNumber: 'TT gearmotor',
  category: 'actuator',
  description: 'Brushed DC gearmotor, 3-6 V. The one in every two-wheeled robot kit.',
  package: { type: 'module', widthMm: 20, heightMm: 16, pinPitchMm: PITCH, bodyColor: '#3f4248' },
  pins: row(
    [
      // 8 ohm winding: 625 mA across 5 V, which is well past what any pin can supply and is
      // precisely the point. Wire this to a pin and the fault detector says so.
      { name: 'M1', model: internal('M2', { ohms: 8 }), description: 'Terminal 1' },
      { name: 'M2', model: ground(), description: 'Terminal 2' },
    ],
    13,
  ),
  state: [],
  behavior: { kind: 'passive' },
  limits: { vccMaxVolts: 6, pinMaxAmps: 1 },
  provenance: builtin([
    'The winding resistance is the stall figure. A spinning motor generates back-EMF that opposes ' +
      'the supply and cuts the current several-fold, and that is not modelled -- so running ' +
      'current here reads as stall current.',
    'Winding inductance is not modelled either, so the inductive kick a flyback diode exists to ' +
      'catch never appears. Fit the diode anyway.',
  ]),
};

export const VIBRATION_MOTOR: ComponentManifest = {
  schemaVersion: 1,
  id: 'vibration-motor',
  name: 'Vibration Motor',
  manufacturer: 'Generic',
  partNumber: 'Coin type 1027',
  category: 'actuator',
  description: 'Coin vibration motor, 3 V. Around 80 mA -- borderline on a pin.',
  package: { type: 'module', widthMm: 10, heightMm: 10, pinPitchMm: PITCH, bodyColor: '#3f4248' },
  pins: row(
    [
      { name: '+', model: internal('-', { ohms: 60 }), description: 'Positive terminal' },
      { name: '-', model: ground(), description: 'Negative terminal' },
    ],
    7,
  ),
  state: [],
  behavior: { kind: 'passive' },
  limits: { vccMaxVolts: 3.6, pinMaxAmps: 0.1 },
  provenance: builtin([
    'Rated 3 V. On a 5 V pin it draws around 80 mA, twice a pin\'s absolute maximum, which the ' +
      'fault detector will flag -- correctly.',
  ]),
};

export const RELAY_MODULE: ComponentManifest = {
  schemaVersion: 1,
  id: 'relay-5v',
  name: '5 V Relay Module (1 channel)',
  manufacturer: 'Generic',
  partNumber: 'SRD-05VDC-SL-C',
  category: 'actuator',
  description: 'Opto-isolated relay board. Switches mains-rated contacts from a logic pin.',
  package: { type: 'module', widthMm: 43, heightMm: 17.3, pinPitchMm: PITCH, bodyColor: '#1c3a6e' },
  pins: [
    ...row(
      [
        // The coil is the whole electrical story: about 70 mA whenever it is energised, which is
        // nearly twice what a pin can source and is why these boards need their own supply.
        { name: 'VCC', model: power(5, { vMin: 4.5, vMax: 5.5, iQuiescent: 0.07 }), description: 'Coil supply' },
        { name: 'GND', model: ground(), description: 'Ground' },
        { name: 'IN', model: digitalIn(5, { pull: 'up', pullOhms: 10_000 }), description: 'Control input, active low' },
      ],
      14,
    ),
    ...row(
      [
        { name: 'NO', model: { kind: 'nc' }, description: 'Normally-open contact' },
        { name: 'COM', model: { kind: 'nc' }, description: 'Common contact' },
        { name: 'NC', model: { kind: 'nc' }, description: 'Normally-closed contact' },
      ],
      0,
      PITCH * 10,
    ),
  ],
  state: [],
  behavior: { kind: 'passive' },
  limits: { vccMaxVolts: 5.5, vccMinVolts: 4.5, pinMaxAmps: 0.02, totalMaxAmps: 0.08 },
  provenance: builtin([
    'The contacts do not switch. COM, NO and NC are declared as unconnected, so a load wired ' +
      'through them will not see the relay operate -- the switched side is outside what the ' +
      'archetypes can express today.',
    'The coil current is constant rather than following IN, so the board draws its 70 mA from the ' +
      'moment it is powered. That over-states quiescent draw and correctly states energised draw, ' +
      'which is the figure that browns boards out.',
    'Most of these modules are active low: the relay pulls in when IN is driven LOW.',
  ]),
};

export const RGB_LED: ComponentManifest = {
  schemaVersion: 1,
  id: 'rgb-led',
  name: 'RGB LED (common cathode)',
  manufacturer: 'Generic',
  partNumber: '5 mm RGB',
  category: 'actuator',
  description: 'Three LEDs in one package sharing a cathode. Needs three series resistors.',
  package: { type: 'radial', widthMm: 12.7, heightMm: 9, pinPitchMm: PITCH, bodyColor: '#d8dde5' },
  pins: row(
    [
      // Different forward voltages per colour, which is exactly why one resistor value for all
      // three gives a colour cast: at a common resistor the red runs brighter than the blue.
      { name: 'R', model: led('COM', { color: 'red', vf: 2, ifNominalA: 0.02 }), description: 'Red anode' },
      { name: 'COM', model: ground(), description: 'Common cathode' },
      { name: 'G', model: led('COM', { color: 'green', vf: 3.2, ifNominalA: 0.02 }), description: 'Green anode' },
      { name: 'B', model: led('COM', { color: 'blue', vf: 3.2, ifNominalA: 0.02 }), description: 'Blue anode' },
    ],
    7,
  ),
  state: [],
  behavior: { kind: 'passive' },
  limits: { pinMaxAmps: 0.03 },
  provenance: builtin([
    'Common cathode. Common-anode parts look identical and behave inverted, which is the usual ' +
      'reason an RGB LED shows the wrong colours.',
  ]),
};

export const ACTUATORS: readonly ComponentManifest[] = [
  SERVO_SG90,
  BUZZER_ACTIVE,
  BUZZER_PASSIVE,
  DC_MOTOR,
  VIBRATION_MOTOR,
  RELAY_MODULE,
  RGB_LED,
];
