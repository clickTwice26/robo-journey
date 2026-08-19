/**
 * Starter circuits.
 *
 * Each one is a complete, physically buildable project: the parts sit at real coordinates on the
 * 0.1" pitch, and every leg is in a hole it could actually reach. Loading one and pressing Run is
 * the fastest way to see the simulator do something true.
 */
import { PITCH_MM } from './registry.js';
import { parseProject, type Project } from './project.js';

/** Breadboard origin used by the examples, and the y of each row. */
const BB_Y = 63.5;
const ROW_OFFSET: Record<string, number> = {
  A: 3, B: 4, C: 5, D: 6, E: 7, F: 9, G: 10, H: 11, I: 12, J: 13,
};
const rowY = (row: string): number => BB_Y + (ROW_OFFSET[row] ?? 0) * PITCH_MM;
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
        { id: 'bb1', type: 'breadboard-half', x: 0, y: BB_Y },
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
        { id: 'bb1', type: 'breadboard-half', x: 0, y: BB_Y },
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
        { id: 'sw1', type: 'pushbutton', x: colX(5), y: rowY('E') },
        { id: 'r1', type: 'resistor', x: colX(12), y: rowY('B'), props: { ohms: 220 } },
        { id: 'led1', type: 'led', x: colX(16), y: rowY('C'), props: { color: 'green' } },
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

export const EXAMPLES: readonly Example[] = [BLINK, NO_RESISTOR, BUTTON];

export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}
