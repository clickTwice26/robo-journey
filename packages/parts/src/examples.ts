/**
 * Starter circuits.
 *
 * Each one is a complete, physically buildable project: the parts sit at real coordinates on the
 * 0.1" pitch, and every leg is in a hole it could actually reach. Loading one and pressing Run is
 * the fastest way to see the simulator do something true.
 */
import {
  HALF_SIZE_BREADBOARD,
  MINI_BREADBOARD,
  rowOffset,
  type BreadboardRow,
} from '@robo-journey/sim-core';
import { PITCH_MM } from './registry.js';
import { parseProject, type Project } from './project.js';

/**
 * Breadboard origin used by the examples, and the y of each row.
 *
 * Row offsets come from `rowOffset` rather than a local table so an example's legs land in the
 * holes the netlist actually wires -- the two drifting apart is exactly the misalignment that a
 * duplicated table invites.
 */
const BB_Y = 63.5;
const rowY = (row: BreadboardRow): number =>
  BB_Y + rowOffset(MINI_BREADBOARD, row) * PITCH_MM;
const colX = (column: number): number => column * PITCH_MM;

export interface Example {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  build(): Project;
}

/**
 * Blink with an external LED.
 *
 * The resistor spans columns 5 to 9 because a through-hole resistor is bent to a 0.4" span; the
 * LED spans 9 to 10, one 0.1" pitch. Those are the real geometries, which is why the legs land in
 * the holes they do.
 */
const BLINK: Example = {
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
        { id: 'r1', type: 'resistor', x: colX(5), y: rowY('B'), props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: colX(9), y: rowY('C'), props: { color: 'red' } },
      ],
      wires: [
        { id: 'w1', from: 'uno1:D13', to: 'bb1:5A' },
        { id: 'w2', from: 'r1:a', to: 'bb1:5B' },
        { id: 'w3', from: 'r1:b', to: 'bb1:9B' },
        { id: 'w4', from: 'led1:anode', to: 'bb1:9C' },
        { id: 'w5', from: 'led1:cathode', to: 'bb1:10C' },
        { id: 'w6', from: 'bb1:10A', to: 'uno1:GND', color: '#2c3e50' },
      ],
      sketch: [
        {
          name: 'sketch.ino',
          contents: [
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
            '',
          ].join('\n'),
        },
      ],
    }),
};

/**
 * The same circuit with the resistor left out.
 *
 * Included deliberately. It looks identical, it "works" in a logic-level simulator, and it is how
 * people kill a pin -- so being able to load it and watch the Problems panel name the current is
 * the clearest possible demonstration of what this simulator is for.
 */
const NO_RESISTOR: Example = {
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
        { id: 'led1', type: 'led', x: colX(5), y: rowY('C'), props: { color: 'red' } },
      ],
      wires: [
        { id: 'w1', from: 'uno1:D13', to: 'bb1:5A' },
        { id: 'w4', from: 'led1:anode', to: 'bb1:5C' },
        { id: 'w5', from: 'led1:cathode', to: 'bb1:6C' },
        { id: 'w6', from: 'bb1:6A', to: 'uno1:GND', color: '#2c3e50' },
      ],
      sketch: BLINK.build().sketch,
    }),
};

/** Button on D2 with the internal pull-up, mirrored to the built-in LED. */
/** Row y on the half-size board, which sits two pitches lower because it carries power rails. */
const halfRowY = (row: BreadboardRow): number =>
  BB_Y + rowOffset(HALF_SIZE_BREADBOARD, row) * PITCH_MM;

const BUTTON: Example = {
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
        { id: 'sw1', type: 'pushbutton', x: colX(5), y: halfRowY('E') },
        { id: 'r1', type: 'resistor', x: colX(12), y: halfRowY('B'), props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: colX(16), y: halfRowY('C'), props: { color: 'green' } },
      ],
      wires: [
        { id: 'w1', from: 'uno1:D2', to: 'bb1:5A' },
        { id: 'w2', from: 'sw1:1a', to: 'bb1:5E' },
        { id: 'w3', from: 'sw1:2a', to: 'bb1:7E' },
        { id: 'w4', from: 'bb1:7A', to: 'uno1:GND', color: '#2c3e50' },
        { id: 'w5', from: 'uno1:D13', to: 'bb1:12A' },
        { id: 'w6', from: 'r1:a', to: 'bb1:12B' },
        { id: 'w7', from: 'r1:b', to: 'bb1:16B' },
        { id: 'w8', from: 'led1:anode', to: 'bb1:16C' },
        { id: 'w9', from: 'led1:cathode', to: 'bb1:17C' },
        { id: 'w10', from: 'bb1:17A', to: 'uno1:GND2', color: '#2c3e50' },
      ],
      sketch: [
        {
          name: 'sketch.ino',
          contents: [
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
            '',
          ].join('\n'),
        },
      ],
    }),
};

/**
 * Serial output, for the logic analyser.
 *
 * No external parts: the point is the waveform on D1. Turn on "Decode D1 as serial" in the Scope
 * and the analyser reads the bytes back off the wire, which is a different claim from the serial
 * monitor showing them -- the monitor reports what the peripheral said it sent, the analyser
 * reports what actually reached the pin.
 */
const SERIAL: Example = {
  id: 'serial',
  name: 'Serial output',
  description: 'Prints over the USART. Open the Scope and decode D1 to read it off the wire.',
  build: () =>
    parseProject({
      version: 1,
      name: 'Serial',
      parts: [{ id: 'uno1', type: 'arduino-uno', x: 0, y: 0 }],
      wires: [],
      sketch: [
        {
          name: 'sketch.ino',
          contents: [
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
            '',
          ].join('\n'),
        },
      ],
    }),
};

/**
 * The instruments, on a circuit worth pointing them at.
 *
 * A divider is the right first thing to measure because you can work out the answer in your head
 * and then see whether the meter agrees -- and because the junction of two resistors is exactly the
 * kind of node no Arduino pin reaches, which is the reason the meter is a part with probes.
 */
const PROBING: Example = {
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
        { id: 'r1', type: 'resistor', x: colX(5), y: rowY('B'), props: { ohms: 1000 } },
        { id: 'r2', type: 'resistor', x: colX(9), y: rowY('C'), props: { ohms: 1000 } },
        { id: 'dmm1', type: 'multimeter', x: 0, y: 100, props: { mode: 'volts' } },
        { id: 'scope1', type: 'oscilloscope', x: 0, y: 152, props: { span: 2, voltsPerDiv: 1, offsetVolts: 2.5 } },
      ],
      wires: [
        { id: 'w1', from: 'uno1:5V', to: 'bb1:5A', color: '#d84a4a' },
        { id: 'w2', from: 'r1:a', to: 'bb1:5B' },
        { id: 'w3', from: 'r1:b', to: 'bb1:9B' },
        { id: 'w4', from: 'r2:a', to: 'bb1:9C' },
        { id: 'w5', from: 'r2:b', to: 'bb1:13C' },
        { id: 'w6', from: 'bb1:13A', to: 'uno1:GND', color: '#2c3e50' },
        // The measurement the board itself cannot take: the junction, halfway down the divider.
        { id: 'w7', from: 'dmm1:V', to: 'bb1:9A', color: '#d84a4a' },
        { id: 'w8', from: 'dmm1:COM', to: 'bb1:13B', color: '#2c3e50' },
        // The scope's ground clip is a real wire. Without it the trace has no reference.
        { id: 'w9', from: 'scope1:CH1', to: 'uno1:D13', color: '#f5d442' },
        { id: 'w10', from: 'scope1:GND', to: 'uno1:GND2', color: '#3ecf8e' },
      ],
      sketch: BLINK.build().sketch,
    }),
};

export const EXAMPLES: readonly Example[] = [BLINK, NO_RESISTOR, BUTTON, SERIAL, PROBING];

export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
