/**
 * The library: prebuilt projects, grouped by what they teach.
 *
 * Each one is a complete, physically buildable circuit -- parts at real coordinates on the 0.1"
 * pitch, every leg in a hole it could actually reach, and a sketch that does something. Loading
 * one and pressing Run is the fastest way to see the simulator do something true, and the fastest
 * way to start a project of your own is to open the nearest one and change it.
 *
 * Grouped rather than listed because a flat menu of twenty circuits is a menu nobody reads. The
 * groups are the order someone actually meets this stuff: get a pin to do something, read
 * something, drive something, talk to something, power it, measure it.
 *
 * ## Where the coordinates come from
 *
 * `at()` places a part by where one of its pins has to land rather than by where its corner goes.
 * A photoresistor's first lead is 2.54 mm in from its own origin and a TO-92's is 5.5 mm down, and
 * doing that arithmetic by hand twenty times is twenty chances to put a leg one hole out -- which
 * looks fine on the canvas and simply does not conduct.
 */
import {
  HALF_SIZE_BREADBOARD,
  MINI_BREADBOARD,
  rowOffset,
  type BreadboardRow,
} from '@robo-journey/sim-core';
import { PITCH_MM, partDefinition } from './registry.js';
import { installBuiltinManifests } from './builtin-manifests.js';
import { parseProject, type Project, type Wire } from './project.js';

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/** Where the breadboard sits, and the y of each of its rows. */
const BB_Y = 63.5;
const rowY = (row: BreadboardRow): number => BB_Y + rowOffset(MINI_BREADBOARD, row) * PITCH_MM;
const halfRowY = (row: BreadboardRow): number =>
  BB_Y + rowOffset(HALF_SIZE_BREADBOARD, row) * PITCH_MM;
const colX = (column: number): number => column * PITCH_MM;

/**
 * Position a part so that one of its pins lands exactly on a point.
 *
 * The whole reason the geometry in here can be trusted: a leg one hole out of place is invisible
 * on screen and fatal to the circuit, and this makes that mistake unrepresentable.
 */
function at(type: string, pin: string, x: number, y: number): { x: number; y: number } {
  installBuiltinManifests();
  const definition = partDefinition(type);
  const spec = definition.pins.find((p) => p.name === pin);
  if (!spec) throw new Error(`${type} has no pin "${pin}"`);
  return { x: x - spec.x, y: y - spec.y };
}

/** Wires, numbered for you. Colour is optional and only ever cosmetic. */
const wires = (...pairs: readonly (readonly [string, string, string?])[]): Wire[] =>
  pairs.map(([from, to, color], index) => ({
    id: `w${index + 1}`,
    from,
    to,
    ...(color ? { color } : {}),
  })) as Wire[];

const GND = '#2c3e50';
const PWR = '#d84a4a';

const sketch = (...lines: string[]) => [{ name: 'sketch.ino', contents: `${lines.join('\n')}\n` }];

// ---------------------------------------------------------------------------------------------

export interface LibraryProject {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  build(): Project;
}

export interface LibraryGroup {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly projects: readonly LibraryProject[];
}

// ---------------------------------------------------------------------------------------------
// First steps
// ---------------------------------------------------------------------------------------------

const BLINK_SKETCH = sketch(
  '// Blink an LED wired to D13 through a 220 ohm resistor.',
  'void setup() {',
  '  pinMode(13, OUTPUT);',
  '}',
  '',
  'void loop() {',
  '  digitalWrite(13, HIGH);',
  '  delay(500);',
  '  digitalWrite(13, LOW);',
  '  delay(500);',
  '}',
);

/**
 * Blink with an external LED.
 *
 * The resistor spans columns 5 to 9 because a through-hole resistor is bent to a 0.4" span; the
 * LED spans 9 to 10, one 0.1" pitch. Those are the real geometries, which is why the legs land in
 * the holes they do.
 */
const BLINK: LibraryProject = {
  id: 'blink',
  name: 'Blink an LED',
  description: 'D13 through a 220R resistor to a red LED. The circuit every kit starts with.',
  build: () =>
    parseProject({
      version: 1,
      name: 'Blink',
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 },
        { id: 'bb1', type: 'breadboard-mini', x: 0, y: BB_Y },
        { id: 'r1', type: 'resistor', ...at('resistor', 'a', colX(5), rowY('B')), props: { ohms: 220 } },
        { id: 'led1', type: 'led', ...at('led', 'anode', colX(9), rowY('C')), props: { color: 'red' } },
      ],
      wires: wires(
        ['uno1:D13', 'bb1:5A'],
        ['r1:a', 'bb1:5B'],
        ['r1:b', 'bb1:9B'],
        ['led1:anode', 'bb1:9C'],
        ['led1:cathode', 'bb1:10C'],
        ['bb1:10A', 'uno1:GND', GND],
      ),
      sketch: BLINK_SKETCH,
    }),
};

const NO_RESISTOR: LibraryProject = {
  id: 'no-resistor',
  name: 'LED without a resistor',
  description: 'The same blink, resistor omitted. Watch the Problems panel.',
  build: () =>
    parseProject({
      version: 1,
      name: 'LED without a resistor',
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 },
        { id: 'bb1', type: 'breadboard-mini', x: 0, y: BB_Y },
        { id: 'led1', type: 'led', ...at('led', 'anode', colX(5), rowY('C')), props: { color: 'red' } },
      ],
      wires: wires(
        ['uno1:D13', 'bb1:5A'],
        ['led1:anode', 'bb1:5C'],
        ['led1:cathode', 'bb1:6C'],
        ['bb1:6A', 'uno1:GND', GND],
      ),
      sketch: BLINK_SKETCH,
    }),
};

const BUTTON: LibraryProject = {
  id: 'button',
  name: 'Button with pull-up',
  description: 'A pushbutton on D2 using INPUT_PULLUP, driving an LED on D13.',
  build: () =>
    parseProject({
      version: 1,
      name: 'Button',
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 },
        { id: 'bb1', type: 'breadboard-half', x: 0, y: BB_Y },
        // A tactile switch straddles the centre channel, which is the only way its two contacts
        // land on separate strips.
        { id: 'sw1', type: 'pushbutton', ...at('pushbutton', '1a', colX(5), halfRowY('E')) },
        { id: 'r1', type: 'resistor', ...at('resistor', 'a', colX(12), halfRowY('B')), props: { ohms: 220 } },
        { id: 'led1', type: 'led', ...at('led', 'anode', colX(16), halfRowY('C')), props: { color: 'green' } },
      ],
      wires: wires(
        ['uno1:D2', 'bb1:5A'],
        ['sw1:1a', 'bb1:5E'],
        ['sw1:2a', 'bb1:7E'],
        ['bb1:7A', 'uno1:GND', GND],
        ['uno1:D13', 'bb1:12A'],
        ['r1:a', 'bb1:12B'],
        ['r1:b', 'bb1:16B'],
        ['led1:anode', 'bb1:16C'],
        ['led1:cathode', 'bb1:17C'],
        ['bb1:17A', 'uno1:GND2', GND],
      ),
      sketch: sketch(
        '// Pressed reads LOW, because the internal pull-up holds the pin high until the',
        '// button shorts it to ground.',
        'const int BUTTON = 2;',
        '',
        'void setup() {',
        '  pinMode(BUTTON, INPUT_PULLUP);',
        '  pinMode(13, OUTPUT);',
        '}',
        '',
        'void loop() {',
        '  digitalWrite(13, digitalRead(BUTTON) == LOW ? HIGH : LOW);',
        '}',
      ),
    }),
};

/** analogWrite on a pin that has a timer behind it, which is the whole trick. */
const FADE: LibraryProject = {
  id: 'fade',
  name: 'Fade an LED',
  description: 'PWM on D9. Put the scope on it to see the duty cycle change rather than a level.',
  build: () =>
    parseProject({
      version: 1,
      name: 'Fade',
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 },
        { id: 'bb1', type: 'breadboard-mini', x: 0, y: BB_Y },
        { id: 'r1', type: 'resistor', ...at('resistor', 'a', colX(5), rowY('B')), props: { ohms: 220 } },
        { id: 'led1', type: 'led', ...at('led', 'anode', colX(9), rowY('C')), props: { color: 'blue' } },
        { id: 'scope1', type: 'oscilloscope', x: 0, y: 110, props: { span: 0.02, voltsPerDiv: 1, offsetVolts: 2.5 } },
      ],
      wires: wires(
        ['uno1:D9', 'bb1:5A'],
        ['r1:a', 'bb1:5B'],
        ['r1:b', 'bb1:9B'],
        ['led1:anode', 'bb1:9C'],
        ['led1:cathode', 'bb1:10C'],
        ['bb1:10A', 'uno1:GND', GND],
        ['scope1:CH1', 'uno1:D9', '#f5d442'],
        ['scope1:GND', 'uno1:GND2', '#3ecf8e'],
      ),
      sketch: sketch(
        '// analogWrite is not an analog voltage. It is a square wave whose duty cycle you set,',
        '// which is why the scope shows a switching waveform and the LED looks dim.',
        'void setup() {',
        '  pinMode(9, OUTPUT);',
        '}',
        '',
        'void loop() {',
        '  for (int level = 0; level <= 255; level += 5) {',
        '    analogWrite(9, level);',
        '    delay(20);',
        '  }',
        '  for (int level = 255; level >= 0; level -= 5) {',
        '    analogWrite(9, level);',
        '    delay(20);',
        '  }',
        '}',
      ),
    }),
};

const SERIAL: LibraryProject = {
  id: 'serial',
  name: 'Serial output',
  description: 'Printing over UART. Decode D1 in the Scope to read the bytes off the wire.',
  build: () =>
    parseProject({
      version: 1,
      name: 'Serial',
      parts: [{ id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 }],
      wires: [],
      sketch: sketch(
        '// Watch D1 in the Scope with serial decoding on: the bytes below appear as a',
        '// waveform first and as text second.',
        'int count = 0;',
        '',
        'void setup() {',
        '  Serial.begin(9600);',
        '}',
        '',
        'void loop() {',
        '  Serial.print("count=");',
        '  Serial.println(count++);',
        '  delay(200);',
        '}',
      ),
    }),
};

// ---------------------------------------------------------------------------------------------
// Sensing
// ---------------------------------------------------------------------------------------------

/** A module wired straight to the header, which is how anyone actually uses a breakout. */
function moduleProject(
  id: string,
  name: string,
  description: string,
  part: { id: string; type: string; props?: Record<string, unknown> },
  extraParts: Record<string, unknown>[],
  links: readonly (readonly [string, string, string?])[],
  code: string[],
): LibraryProject {
  return {
    id,
    name,
    description,
    build: () =>
      parseProject({
        version: 1,
        name,
        parts: [
          { id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 },
          { ...part, x: 0, y: 70 },
          ...extraParts,
        ],
        wires: wires(...links),
        sketch: sketch(...code),
      }),
  };
}

const LIGHT_SENSOR: LibraryProject = {
  id: 'light-sensor',
  name: 'Light sensor',
  description: 'A photoresistor and a 10k in a divider on A0. Drag the lamp nearer and watch A0 move.',
  build: () =>
    parseProject({
      version: 1,
      name: 'Light sensor',
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 },
        { id: 'bb1', type: 'breadboard-mini', x: 0, y: BB_Y },
        { id: 'ldr', type: 'photoresistor', ...at('photoresistor', 'A', colX(5), rowY('B')) },
        { id: 'r1', type: 'resistor', ...at('resistor', 'a', colX(6), rowY('C')), props: { ohms: 10000 } },
        { id: 'lamp', type: 'stim-lamp', x: 60, y: 110, props: { lux: 800, reachMm: 60 } },
      ],
      wires: wires(
        ['uno1:5V', 'bb1:5A', PWR],
        ['ldr:A', 'bb1:5B'],
        ['ldr:B', 'bb1:6B'],
        // The junction of the two, which is what the ADC reads.
        ['bb1:6A', 'uno1:A0'],
        ['r1:a', 'bb1:6C'],
        ['r1:b', 'bb1:10C'],
        ['bb1:10A', 'uno1:GND', GND],
      ),
      sketch: sketch(
        '// A divider: the photoresistor on top, a fixed 10k underneath. More light means less',
        '// resistance up top, which pulls A0 higher.',
        'void setup() {',
        '  Serial.begin(9600);',
        '}',
        '',
        'void loop() {',
        '  int raw = analogRead(A0);',
        '  Serial.print("light=");',
        '  Serial.println(raw);',
        '  delay(200);',
        '}',
      ),
    }),
};

const FLAME_ALARM = moduleProject(
  'flame-alarm',
  'Flame alarm',
  'A flame sensor and a buzzer. Drag the flame from the toolkit to set it off.',
  { id: 'fs', type: 'flame-sensor' },
  [
    { id: 'buz', type: 'buzzer-active', x: 70, y: 70 },
    { id: 'fire', type: 'stim-flame', x: 70, y: 130, props: { on: false } },
  ],
  [
    ['fs:VCC', 'uno1:5V', PWR],
    ['fs:GND', 'uno1:GND', GND],
    ['fs:AOUT', 'uno1:A0'],
    ['buz:+', 'uno1:D8'],
    ['buz:-', 'uno1:GND2', GND],
  ],
  [
    '// The flame sensor is an infrared photodiode: the closer the fire, the higher A0 reads.',
    '// Switch the flame on in the Properties panel, then drag it nearer.',
    'const int THRESHOLD = 400;',
    '',
    'void setup() {',
    '  pinMode(8, OUTPUT);',
    '  Serial.begin(9600);',
    '}',
    '',
    'void loop() {',
    '  int ir = analogRead(A0);',
    '  digitalWrite(8, ir > THRESHOLD ? HIGH : LOW);',
    '  Serial.print("ir=");',
    '  Serial.println(ir);',
    '  delay(100);',
    '}',
  ],
);

const MOTION_LIGHT = moduleProject(
  'motion-light',
  'Motion-activated light',
  'A PIR on D2 switching the built-in LED. Drag the moving object into range.',
  { id: 'pir', type: 'hc-sr501' },
  [{ id: 'walker', type: 'stim-motion', x: 70, y: 130, props: { on: false } }],
  [
    ['pir:VCC', 'uno1:5V', PWR],
    ['pir:GND', 'uno1:GND', GND],
    ['pir:OUT', 'uno1:D2'],
  ],
  [
    '// The HC-SR501 drives its output HIGH while it sees movement, which is the opposite of',
    '// most modules -- plenty of sketches written for something else read it inverted.',
    'void setup() {',
    '  pinMode(2, INPUT);',
    '  pinMode(13, OUTPUT);',
    '  Serial.begin(9600);',
    '}',
    '',
    'void loop() {',
    '  bool seen = digitalRead(2) == HIGH;',
    '  digitalWrite(13, seen);',
    '  if (seen) Serial.println("movement");',
    '  delay(100);',
    '}',
  ],
);

const RANGEFINDER = moduleProject(
  'rangefinder',
  'Ultrasonic rangefinder',
  'An HC-SR04 measuring the distance to an obstacle you can drag around.',
  { id: 'sonar', type: 'hc-sr04' },
  [{ id: 'wall', type: 'stim-obstacle', x: 120, y: 70 }],
  [
    ['sonar:VCC', 'uno1:5V', PWR],
    ['sonar:GND', 'uno1:GND', GND],
    ['sonar:TRIG', 'uno1:D9'],
    ['sonar:ECHO', 'uno1:D10'],
  ],
  [
    '// Pulse TRIG for ten microseconds, then time how long ECHO stays high. Sound covers a',
    '// centimetre and back in about 58 microseconds.',
    'const int TRIG = 9;',
    'const int ECHO = 10;',
    '',
    'void setup() {',
    '  pinMode(TRIG, OUTPUT);',
    '  pinMode(ECHO, INPUT);',
    '  Serial.begin(9600);',
    '}',
    '',
    'void loop() {',
    '  digitalWrite(TRIG, LOW);',
    '  delayMicroseconds(2);',
    '  digitalWrite(TRIG, HIGH);',
    '  delayMicroseconds(10);',
    '  digitalWrite(TRIG, LOW);',
    '',
    '  long us = pulseIn(ECHO, HIGH, 40000);',
    '  Serial.print("cm=");',
    '  Serial.println(us / 58);',
    '  delay(200);',
    '}',
  ],
);

const THERMOMETER = moduleProject(
  'thermometer',
  'Thermometer',
  'A TMP36 on A0. Drag the heat source closer and the reading climbs.',
  { id: 'tmp', type: 'tmp36' },
  [{ id: 'heat', type: 'stim-heat', x: 70, y: 120, props: { on: false } }],
  [
    ['tmp:VS', 'uno1:5V', PWR],
    ['tmp:GND', 'uno1:GND', GND],
    ['tmp:VOUT', 'uno1:A0'],
  ],
  [
    '// 10 mV per degree with a 500 mV offset, which is what lets it read below freezing on a',
    '// single supply -- and what everybody forgets to subtract.',
    'void setup() {',
    '  Serial.begin(9600);',
    '}',
    '',
    'void loop() {',
    '  float volts = analogRead(A0) * (5.0 / 1023.0);',
    '  float celsius = (volts - 0.5) * 100.0;',
    '  Serial.print("temp=");',
    '  Serial.println(celsius);',
    '  delay(500);',
    '}',
  ],
);

const SOUND_METER = moduleProject(
  'sound-meter',
  'Sound level meter',
  'A microphone module on A0 with a sound source you can move around.',
  { id: 'mic', type: 'sound-sensor' },
  [{ id: 'speaker', type: 'stim-sound', x: 80, y: 120, props: { db: 85, reachMm: 50 } }],
  [
    ['mic:VCC', 'uno1:5V', PWR],
    ['mic:GND', 'uno1:GND', GND],
    ['mic:AOUT', 'uno1:A0'],
  ],
  [
    '// These modules give you a level, not a waveform. Reading one fast enough to see a sine',
    '// wave gets you noise, which is why every project using one reads an envelope.',
    'void setup() {',
    '  pinMode(13, OUTPUT);',
    '  Serial.begin(9600);',
    '}',
    '',
    'void loop() {',
    '  int level = analogRead(A0);',
    '  digitalWrite(13, level > 500 ? HIGH : LOW);',
    '  Serial.print("level=");',
    '  Serial.println(level);',
    '  delay(100);',
    '}',
  ],
);

const KNOCK_SENSOR = moduleProject(
  'knock-sensor',
  'Knock sensor',
  'An SW-420 vibration switch on D2. Drop the vibration source next to it.',
  { id: 'vib', type: 'vibration-sensor' },
  [{ id: 'shake', type: 'stim-shaker', x: 70, y: 120, props: { on: false } }],
  [
    ['vib:VCC', 'uno1:5V', PWR],
    ['vib:GND', 'uno1:GND', GND],
    ['vib:DO', 'uno1:D2'],
  ],
  [
    '// The module pulls its output LOW while the spring inside is being shaken.',
    'int knocks = 0;',
    'bool wasShaking = false;',
    '',
    'void setup() {',
    '  pinMode(2, INPUT_PULLUP);',
    '  Serial.begin(9600);',
    '}',
    '',
    'void loop() {',
    '  bool shaking = digitalRead(2) == LOW;',
    '  if (shaking && !wasShaking) {',
    '    Serial.print("knock ");',
    '    Serial.println(++knocks);',
    '  }',
    '  wasShaking = shaking;',
    '  delay(20);',
    '}',
  ],
);

const MAGNET_SWITCH = moduleProject(
  'magnet-switch',
  'Magnetic door sensor',
  'A reed switch on D2. Drag the magnet close -- it has to be very close.',
  { id: 'reed', type: 'reed-switch' },
  [{ id: 'mag', type: 'stim-magnet', x: 60, y: 70 }],
  [
    ['reed:VCC', 'uno1:5V', PWR],
    ['reed:GND', 'uno1:GND', GND],
    ['reed:DO', 'uno1:D2'],
  ],
  [
    '// A magnet field falls off as the cube of the distance, so this is a contact sensor in',
    '// everything but name: a centimetre away is already nothing.',
    'void setup() {',
    '  pinMode(2, INPUT_PULLUP);',
    '  pinMode(13, OUTPUT);',
    '  Serial.begin(9600);',
    '}',
    '',
    'void loop() {',
    '  bool closed = digitalRead(2) == LOW;',
    '  digitalWrite(13, closed);',
    '  Serial.println(closed ? "closed" : "open");',
    '  delay(200);',
    '}',
  ],
);

const SOIL_MONITOR = moduleProject(
  'soil-monitor',
  'Soil moisture monitor',
  'A capacitive probe on A0. Drag the water onto it -- wetter reads lower, not higher.',
  { id: 'soil', type: 'soil-moisture' },
  [{ id: 'water', type: 'stim-water', x: 60, y: 120, props: { on: false } }],
  [
    ['soil:VCC', 'uno1:5V', PWR],
    ['soil:GND', 'uno1:GND', GND],
    ['soil:AOUT', 'uno1:A0'],
  ],
  [
    '// Inverted, and getting this backwards is the single most common mistake with these',
    '// boards: dry soil reads high, wet soil reads low.',
    'void setup() {',
    '  Serial.begin(9600);',
    '}',
    '',
    'void loop() {',
    '  int raw = analogRead(A0);',
    '  Serial.print(raw);',
    '  Serial.println(raw < 400 ? "  wet" : "  dry");',
    '  delay(500);',
    '}',
  ],
);

const GAS_ALARM = moduleProject(
  'gas-alarm',
  'Smoke alarm',
  'An MQ-2 on A0. The flame from the toolkit gives off smoke, so it sets this off too.',
  { id: 'gas', type: 'mq2' },
  [
    { id: 'fire', type: 'stim-flame', x: 80, y: 130, props: { on: false } },
    { id: 'buz', type: 'buzzer-active', x: 80, y: 70 },
  ],
  [
    ['gas:VCC', 'uno1:5V', PWR],
    ['gas:GND', 'uno1:GND', GND],
    ['gas:AOUT', 'uno1:A0'],
    ['buz:+', 'uno1:D8'],
    ['buz:-', 'uno1:GND2', GND],
  ],
  [
    '// Nobody wired the flame to this sensor. A fire gives off smoke, and the sensor is in it.',
    '// The heater alone draws 150 mA, which is most of what a USB-powered board has spare.',
    '',
    '// About 1250 ppm. Clean air reads around 115 and the sensor saturates near 900, so a',
    '// threshold much above this only trips when the fire is already touching the sensor.',
    'const int THRESHOLD = 180;',
    '',
    'void setup() {',
    '  pinMode(8, OUTPUT);',
    '  Serial.begin(9600);',
    '}',
    '',
    'void loop() {',
    '  int raw = analogRead(A0);',
    '  digitalWrite(8, raw > THRESHOLD ? HIGH : LOW);',
    '  Serial.print("smoke=");',
    '  Serial.println(raw);',
    '  delay(200);',
    '}',
  ],
);

// ---------------------------------------------------------------------------------------------
// Driving things
// ---------------------------------------------------------------------------------------------

const SERVO_SWEEP = moduleProject(
  'servo-sweep',
  'Servo sweep',
  'An SG90 on D9. Watch the horn follow, and watch the supply current while it moves.',
  { id: 'servo', type: 'sg90' },
  [],
  [
    ['servo:VCC', 'uno1:5V', PWR],
    ['servo:GND', 'uno1:GND', GND],
    ['servo:SIG', 'uno1:D9'],
  ],
  [
    '// Written without the Servo library so the pulses are visible in the code: 1 ms is one end',
    '// of the travel, 2 ms the other, repeated every 20 ms.',
    'const int SIG = 9;',
    '',
    'void pulse(int microseconds) {',
    '  digitalWrite(SIG, HIGH);',
    '  delayMicroseconds(microseconds);',
    '  digitalWrite(SIG, LOW);',
    '  delay(20);',
    '}',
    '',
    'void setup() {',
    '  pinMode(SIG, OUTPUT);',
    '}',
    '',
    'void loop() {',
    '  for (int us = 1000; us <= 2000; us += 25) pulse(us);',
    '  for (int us = 2000; us >= 1000; us -= 25) pulse(us);',
    '}',
  ],
);

const BUZZER_TONE = moduleProject(
  'buzzer-tone',
  'Buzzer and microphone',
  'A buzzer on D8 and a sound sensor listening to it. The loop closes inside the simulation.',
  { id: 'buz', type: 'buzzer-passive' },
  [{ id: 'mic', type: 'sound-sensor', x: 70, y: 70 }],
  [
    ['buz:+', 'uno1:D8'],
    ['buz:-', 'uno1:GND', GND],
    ['mic:VCC', 'uno1:5V', PWR],
    ['mic:GND', 'uno1:GND2', GND],
    ['mic:AOUT', 'uno1:A0'],
  ],
  [
    '// The buzzer emits into the workspace and the microphone a few centimetres away hears it.',
    '// Drag them apart and the level the sketch reads falls off.',
    'void setup() {',
    '  pinMode(8, OUTPUT);',
    '  Serial.begin(9600);',
    '}',
    '',
    'void loop() {',
    '  tone(8, 2000, 300);',
    '  delay(400);',
    '  Serial.print("heard=");',
    '  Serial.println(analogRead(A0));',
    '  delay(600);',
    '}',
  ],
);

const RGB_MIXER: LibraryProject = {
  id: 'rgb-mixer',
  name: 'RGB LED mixer',
  description: 'Three PWM channels into one RGB LED, each through its own resistor.',
  build: () =>
    parseProject({
      version: 1,
      name: 'RGB mixer',
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 },
        { id: 'bb1', type: 'breadboard-half', x: 0, y: BB_Y },
        // A through-hole resistor is bent to a 0.4 inch span, so the three cannot start in the
        // same column and end in different ones. Their far ends have to land on the LED's own
        // pins, which are one pitch apart, so the near ends are staggered instead.
        { id: 'rr', type: 'resistor', ...at('resistor', 'a', colX(3), halfRowY('B')), props: { ohms: 220 } },
        { id: 'rg', type: 'resistor', ...at('resistor', 'a', colX(5), halfRowY('C')), props: { ohms: 150 } },
        { id: 'rb', type: 'resistor', ...at('resistor', 'a', colX(6), halfRowY('D')), props: { ohms: 150 } },
        { id: 'rgb', type: 'rgb-led', ...at('rgb-led', 'R', colX(7), halfRowY('E')) },
      ],
      wires: wires(
        ['uno1:D9', 'bb1:3A'],
        ['uno1:D10', 'bb1:5A'],
        ['uno1:D11', 'bb1:6A'],
        ['rr:a', 'bb1:3B'],
        ['rr:b', 'bb1:7B'],
        ['rg:a', 'bb1:5C'],
        ['rg:b', 'bb1:9C'],
        ['rb:a', 'bb1:6D'],
        ['rb:b', 'bb1:10D'],
        ['rgb:R', 'bb1:7E'],
        ['rgb:COM', 'bb1:8E'],
        ['rgb:G', 'bb1:9E'],
        ['rgb:B', 'bb1:10E'],
        ['bb1:8A', 'uno1:GND', GND],
      ),
      sketch: sketch(
        '// Red needs a bigger resistor than green and blue because its forward voltage is a',
        '// volt lower -- one value for all three is why so many RGB LEDs look pink.',
        'void setup() {',
        '  pinMode(9, OUTPUT);',
        '  pinMode(10, OUTPUT);',
        '  pinMode(11, OUTPUT);',
        '}',
        '',
        'void loop() {',
        '  for (int i = 0; i < 256; i++) {',
        '    analogWrite(9, i);',
        '    analogWrite(10, 255 - i);',
        '    analogWrite(11, (i * 2) % 256);',
        '    delay(10);',
        '  }',
        '}',
      ),
    }),
};

const MOTOR_DRIVER: LibraryProject = {
  id: 'motor-driver',
  name: 'Motor on a transistor',
  description: 'A MOSFET switching a motor, with a flyback diode. Never wire a motor to a pin.',
  build: () =>
    parseProject({
      version: 1,
      name: 'Motor driver',
      // No breadboard: a motor and a battery pack have flying leads rather than legs, and every
      // connection here is one thing's terminal to another's, which is how it goes together on a
      // bench too.
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 },
        { id: 'q1', type: 'irlz44n', x: 20, y: 75 },
        { id: 'd1', type: '1n4007', x: 75, y: 75 },
        { id: 'm1', type: 'dc-motor', x: 120, y: 70 },
        { id: 'bat', type: 'battery-aa-4', x: 175, y: 70 },
      ],
      wires: wires(
        ['uno1:D9', 'q1:G'],
        // Source to ground, and the battery's negative to the same ground -- a shared return is
        // what makes the two supplies one circuit rather than two.
        ['q1:S', 'uno1:GND', GND],
        ['q1:S', 'bat:-', GND],
        // The motor sits between the supply and the drain: the transistor switches the low side.
        ['bat:+', 'm1:M1', PWR],
        ['m1:M2', 'q1:D'],
        // Flyback diode across the motor, cathode to the positive end. Backwards, it is a short.
        ['d1:K', 'm1:M1'],
        ['d1:A', 'm1:M2'],
      ),
      sketch: sketch(
        '// A logic-level MOSFET switches the motor and the diode across it absorbs the',
        '// inductive kick when it turns off. A motor wired straight to a pin draws over half an',
        '// amp -- try that circuit and watch the Problems panel.',
        'void setup() {',
        '  pinMode(9, OUTPUT);',
        '}',
        '',
        'void loop() {',
        '  for (int speed = 0; speed <= 255; speed += 5) {',
        '    analogWrite(9, speed);',
        '    delay(30);',
        '  }',
        '  analogWrite(9, 0);',
        '  delay(1000);',
        '}',
      ),
    }),
};

const RELAY_SWITCH = moduleProject(
  'relay-switch',
  'Relay module',
  'A relay board on D7. Watch the supply current: the coil alone is 70 mA.',
  { id: 'rel', type: 'relay-5v' },
  [],
  [
    ['rel:VCC', 'uno1:5V', PWR],
    ['rel:GND', 'uno1:GND', GND],
    ['rel:IN', 'uno1:D7'],
  ],
  [
    '// Most of these boards are active low: the relay pulls in when IN goes LOW.',
    '// The contacts are not simulated -- what is, is the 70 mA the coil takes.',
    'void setup() {',
    '  pinMode(7, OUTPUT);',
    '  digitalWrite(7, HIGH);',
    '}',
    '',
    'void loop() {',
    '  digitalWrite(7, LOW);',
    '  delay(2000);',
    '  digitalWrite(7, HIGH);',
    '  delay(2000);',
    '}',
  ],
);

const SHIFT_REGISTER = moduleProject(
  'shift-register',
  'Shift register',
  'A 74HC595 driven over SPI. Three pins become eight outputs.',
  { id: 'sr', type: 'sn74hc595' },
  [],
  [
    ['sr:VCC', 'uno1:5V', PWR],
    ['sr:GND', 'uno1:GND', GND],
    ['sr:SER', 'uno1:D11'],
    ['sr:SRCLK', 'uno1:D13'],
    ['sr:RCLK', 'uno1:D10'],
    ['sr:OE', 'uno1:GND2', GND],
    ['sr:SRCLR', 'uno1:5V', PWR],
  ],
  [
    '// The byte lands on the outputs when the latch rises, not as it shifts in. That is why the',
    '// latch goes low before the transfer and high after it.',
    '#include <SPI.h>',
    '',
    'const int LATCH = 10;',
    '',
    'void setup() {',
    '  pinMode(LATCH, OUTPUT);',
    '  SPI.begin();',
    '}',
    '',
    'void loop() {',
    '  for (int i = 0; i < 8; i++) {',
    '    digitalWrite(LATCH, LOW);',
    '    SPI.transfer(1 << i);',
    '    digitalWrite(LATCH, HIGH);',
    '    delay(120);',
    '  }',
    '}',
  ],
);

// ---------------------------------------------------------------------------------------------
// Buses
// ---------------------------------------------------------------------------------------------

const I2C_SCAN = moduleProject(
  'i2c-scan',
  'I2C bus scan',
  'Three devices on one pair of wires. The scan finds them by address.',
  { id: 'imu', type: 'mpu6050' },
  [
    { id: 'oled', type: 'ssd1306', x: 70, y: 70 },
    { id: 'adc', type: 'ads1115', x: 140, y: 70 },
  ],
  [
    ['imu:VCC', 'uno1:5V', PWR],
    ['imu:GND', 'uno1:GND', GND],
    ['imu:SDA', 'uno1:A4'],
    ['imu:SCL', 'uno1:A5'],
    ['oled:VCC', 'uno1:5V', PWR],
    ['oled:GND', 'uno1:GND2', GND],
    ['oled:SDA', 'uno1:A4'],
    ['oled:SCL', 'uno1:A5'],
    ['adc:VDD', 'uno1:5V', PWR],
    ['adc:GND', 'uno1:GND3', GND],
    ['adc:SDA', 'uno1:A4'],
    ['adc:SCL', 'uno1:A5'],
  ],
  [
    '// The first thing to run when an I2C device will not answer. Every device on the bus shares',
    '// the same two wires and is told apart only by its address.',
    '#include <Wire.h>',
    '',
    'void setup() {',
    '  Serial.begin(9600);',
    '  Wire.begin();',
    '',
    '  Serial.print("found:");',
    '  for (byte address = 8; address < 120; address++) {',
    '    Wire.beginTransmission(address);',
    '    if (Wire.endTransmission() == 0) {',
    '      Serial.print(" 0x");',
    '      Serial.print(address, HEX);',
    '    }',
    '  }',
    '  Serial.println();',
    '}',
    '',
    'void loop() {}',
  ],
);

const IMU_READ = moduleProject(
  'imu-read',
  'Read an accelerometer',
  'An MPU-6050 over I2C. Set the axes in the Properties panel and watch them come back.',
  { id: 'imu', type: 'mpu6050', props: { az: 1 } },
  [],
  [
    ['imu:VCC', 'uno1:5V', PWR],
    ['imu:GND', 'uno1:GND', GND],
    ['imu:SDA', 'uno1:A4'],
    ['imu:SCL', 'uno1:A5'],
  ],
  [
    '// 16384 counts per g in the default range. The registers are big-endian: high byte first.',
    '#include <Wire.h>',
    '',
    'const int MPU = 0x68;',
    '',
    'void setup() {',
    '  Serial.begin(9600);',
    '  Wire.begin();',
    '  Wire.beginTransmission(MPU);',
    '  Wire.write(0x6B);',
    '  Wire.write(0);',
    '  Wire.endTransmission();',
    '}',
    '',
    'void loop() {',
    '  Wire.beginTransmission(MPU);',
    '  Wire.write(0x3B);',
    '  Wire.endTransmission(false);',
    '  Wire.requestFrom(MPU, 6);',
    '',
    '  int16_t x = (Wire.read() << 8) | Wire.read();',
    '  int16_t y = (Wire.read() << 8) | Wire.read();',
    '  int16_t z = (Wire.read() << 8) | Wire.read();',
    '',
    '  Serial.print(x / 16384.0); Serial.print(" ");',
    '  Serial.print(y / 16384.0); Serial.print(" ");',
    '  Serial.println(z / 16384.0);',
    '  delay(300);',
    '}',
  ],
);

const SPI_SENSOR = moduleProject(
  'spi-sensor',
  'SPI and the mode trap',
  'An ADXL345 that needs SPI mode 3. Wired perfectly in mode 0 it returns nothing but zeros.',
  { id: 'acc', type: 'adxl345', props: { az: 1 } },
  [],
  [
    ['acc:VCC', 'uno1:3V3', PWR],
    ['acc:GND', 'uno1:GND', GND],
    ['acc:CS', 'uno1:D10'],
    ['acc:SDO', 'uno1:D12'],
    ['acc:SDA', 'uno1:D11'],
    ['acc:SCL', 'uno1:D13'],
  ],
  [
    '// Change SPI_MODE3 to SPI_MODE0 and read the device id again. Nothing about the wiring',
    '// changes and nothing on a scope looks wrong -- it just stops answering.',
    '#include <SPI.h>',
    '',
    'const int CS = 10;',
    '',
    'byte readRegister(byte reg) {',
    '  digitalWrite(CS, LOW);',
    '  SPI.transfer(reg | 0x80);',
    '  byte value = SPI.transfer(0x00);',
    '  digitalWrite(CS, HIGH);',
    '  return value;',
    '}',
    '',
    'void setup() {',
    '  Serial.begin(9600);',
    '  pinMode(CS, OUTPUT);',
    '  digitalWrite(CS, HIGH);',
    '  SPI.begin();',
    '  SPI.setDataMode(SPI_MODE3);',
    '',
    '  Serial.print("id=");',
    '  Serial.println(readRegister(0x00), HEX);',
    '}',
    '',
    'void loop() {}',
  ],
);

// ---------------------------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------------------------

const REGULATED_SUPPLY: LibraryProject = {
  id: 'regulated-supply',
  name: '5 V from a 9 V battery',
  description: 'A 7805 doing its job. Load it harder and watch the heat, not the voltage.',
  build: () =>
    parseProject({
      version: 1,
      name: 'Regulated supply',
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 },
        { id: 'bat', type: 'battery-9v', x: 0, y: 70 },
        { id: 'reg', type: 'lm7805', x: 60, y: 80 },
        { id: 'load', type: 'resistor', x: 110, y: 80, props: { ohms: 47 } },
        { id: 'dmm', type: 'multimeter', x: 60, y: 130, props: { mode: 'volts' } },
      ],
      wires: wires(
        ['bat:+', 'reg:IN', PWR],
        ['bat:-', 'reg:GND', GND],
        ['reg:GND', 'uno1:GND', GND],
        ['reg:OUT', 'load:a'],
        ['load:b', 'reg:GND', GND],
        ['dmm:V', 'reg:OUT', PWR],
        ['dmm:COM', 'reg:GND', GND],
      ),
      sketch: sketch(
        '// No code needed -- this one is about the power path. Select the regulator and watch',
        '// its junction temperature climb: 9 V in and 5 V out means it is throwing away four',
        '// volts times whatever the load draws, and a bare TO-220 sheds 65 degrees per watt.',
        'void setup() {}',
        'void loop() {}',
      ),
    }),
};

const BATTERY_SAG: LibraryProject = {
  id: 'battery-sag',
  name: 'Why the battery sags',
  description: 'A 9 V alkaline into a heavy load. An ideal source would hold 9 V; this one does not.',
  build: () =>
    parseProject({
      version: 1,
      name: 'Battery sag',
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 },
        { id: 'bat', type: 'battery-9v', x: 0, y: 70 },
        { id: 'load', type: 'resistor', x: 60, y: 80, props: { ohms: 10 } },
        { id: 'dmm', type: 'multimeter', x: 0, y: 130, props: { mode: 'volts' } },
        { id: 'amp', type: 'ammeter', x: 80, y: 130, props: { range: 'A' } },
      ],
      wires: wires(
        ['bat:+', 'load:a', PWR],
        ['load:b', 'amp:in'],
        ['amp:out', 'bat:-', GND],
        ['bat:-', 'uno1:GND', GND],
        ['dmm:V', 'bat:+', PWR],
        ['dmm:COM', 'bat:-', GND],
      ),
      sketch: sketch(
        '// A fresh 9 V alkaline is about 1.7 ohm internally. Into ten ohms that is a divider,',
        '// and the terminals sit near 7.7 V rather than 9. Change the load resistor and watch',
        '// both instruments move together.',
        'void setup() {}',
        'void loop() {}',
      ),
    }),
};

// ---------------------------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------------------------

const PROBING: LibraryProject = {
  id: 'probing',
  name: 'Probe a divider',
  description: 'A multimeter across a 1k/1k divider and a scope on D13. Wire the probes anywhere.',
  build: () =>
    parseProject({
      version: 1,
      name: 'Probe a divider',
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 },
        { id: 'bb1', type: 'breadboard-mini', x: 0, y: BB_Y },
        { id: 'r1', type: 'resistor', ...at('resistor', 'a', colX(5), rowY('B')), props: { ohms: 1000 } },
        { id: 'r2', type: 'resistor', ...at('resistor', 'a', colX(9), rowY('C')), props: { ohms: 1000 } },
        { id: 'dmm1', type: 'multimeter', x: 0, y: 100, props: { mode: 'volts' } },
        { id: 'scope1', type: 'oscilloscope', x: 0, y: 152, props: { span: 2, voltsPerDiv: 1, offsetVolts: 2.5 } },
      ],
      wires: wires(
        ['uno1:5V', 'bb1:5A', PWR],
        ['r1:a', 'bb1:5B'],
        ['r1:b', 'bb1:9B'],
        ['r2:a', 'bb1:9C'],
        ['r2:b', 'bb1:13C'],
        ['bb1:13A', 'uno1:GND', GND],
        ['dmm1:V', 'bb1:9A', PWR],
        ['dmm1:COM', 'bb1:13B', GND],
        ['scope1:CH1', 'uno1:D13', '#f5d442'],
        ['scope1:GND', 'uno1:GND2', '#3ecf8e'],
      ),
      sketch: BLINK_SKETCH,
    }),
};

const CURRENT_MEASURE: LibraryProject = {
  id: 'current-measure',
  name: 'Measure the LED current',
  description: 'An ammeter broken into the LED branch. It has to be in series -- there is no other way.',
  build: () =>
    parseProject({
      version: 1,
      name: 'Measure the LED current',
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 12.7, y: 0 },
        { id: 'bb1', type: 'breadboard-mini', x: 0, y: BB_Y },
        { id: 'r1', type: 'resistor', ...at('resistor', 'a', colX(5), rowY('B')), props: { ohms: 220 } },
        { id: 'led1', type: 'led', ...at('led', 'anode', colX(9), rowY('C')), props: { color: 'red' } },
        { id: 'amp', type: 'ammeter', x: 0, y: 105, props: { range: 'mA' } },
      ],
      wires: wires(
        ['uno1:D13', 'bb1:5A'],
        ['r1:a', 'bb1:5B'],
        ['r1:b', 'bb1:9B'],
        ['led1:anode', 'bb1:9C'],
        ['led1:cathode', 'bb1:10C'],
        // The meter is the last link in the chain rather than a probe across something.
        ['bb1:10A', 'amp:in'],
        ['amp:out', 'uno1:GND', GND],
      ),
      sketch: BLINK_SKETCH,
    }),
};

// ---------------------------------------------------------------------------------------------

export const LIBRARY: readonly LibraryGroup[] = [
  {
    id: 'first-steps',
    name: 'First steps',
    description: 'Getting a pin to do something, and seeing what it costs.',
    projects: [BLINK, NO_RESISTOR, BUTTON, FADE, SERIAL],
  },
  {
    id: 'sensing',
    name: 'Sensing',
    description: 'Reading the world. Every one of these comes with something to trigger it.',
    projects: [
      LIGHT_SENSOR,
      THERMOMETER,
      RANGEFINDER,
      MOTION_LIGHT,
      FLAME_ALARM,
      GAS_ALARM,
      SOUND_METER,
      KNOCK_SENSOR,
      MAGNET_SWITCH,
      SOIL_MONITOR,
    ],
  },
  {
    id: 'driving',
    name: 'Driving things',
    description: 'Making something move, light up or make a noise -- and the parts in between.',
    projects: [SERVO_SWEEP, BUZZER_TONE, RGB_MIXER, MOTOR_DRIVER, RELAY_SWITCH, SHIFT_REGISTER],
  },
  {
    id: 'buses',
    name: 'Talking to chips',
    description: 'I2C and SPI, including the two mistakes everybody makes.',
    projects: [I2C_SCAN, IMU_READ, SPI_SENSOR],
  },
  {
    id: 'power',
    name: 'Power',
    description: 'Where projects actually fail. Nothing here has any code worth reading.',
    projects: [REGULATED_SUPPLY, BATTERY_SAG],
  },
  {
    id: 'measuring',
    name: 'Measuring',
    description: 'Using the instruments on circuits whose answer you already know.',
    projects: [PROBING, CURRENT_MEASURE],
  },
];

/** Every project in the library, flattened. */
export const LIBRARY_PROJECTS: readonly LibraryProject[] = LIBRARY.flatMap((g) => g.projects);

export function libraryProject(id: string): LibraryProject | undefined {
  return LIBRARY_PROJECTS.find((p) => p.id === id);
}
