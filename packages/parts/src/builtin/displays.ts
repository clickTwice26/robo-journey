/**
 * Displays.
 *
 * These are the parts where the archetypes are most obviously an abstraction: the bus traffic is
 * simulated exactly, the glass is not. A sketch driving an SSD1306 will address it, write to it and
 * be acknowledged -- and the simulator will not draw what it sent. That boundary is stated in every
 * `unresolved` here rather than papered over, because a blank simulated screen that is blank for
 * the wrong reason would send someone hunting a wiring fault that does not exist.
 *
 * What they do catch is everything electrical and everything on the wire: the wrong address, the
 * missing pull-ups, the 5 V module on a 3.3 V rail, the backlight that pushes the supply over
 * budget.
 */
import type { ComponentManifest } from '../manifest.js';
import { PITCH, builtin, digitalIn, digitalOut, ground, i2c, led, power, reg, row, spi } from './kit.js';

export const SSD1306_OLED: ComponentManifest = {
  schemaVersion: 1,
  id: 'ssd1306',
  name: 'SSD1306 OLED 128x64',
  manufacturer: 'Solomon Systech',
  partNumber: 'SSD1306',
  category: 'display',
  description: '0.96 inch monochrome OLED on I2C. The default small display.',
  package: { type: 'module', widthMm: 27, heightMm: 27, pinPitchMm: PITCH, bodyColor: '#12161c' },
  pins: row(
    [
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'VCC', model: power(3.3, { vMin: 3.3, vMax: 5, iQuiescent: 0.02 }), description: 'Supply' },
      { name: 'SCL', model: digitalIn(3.3), description: 'I2C clock' },
      { name: 'SDA', model: digitalIn(3.3), description: 'I2C data' },
    ],
    24,
  ),
  state: [],
  // The SSD1306 has no register file: every transfer starts with a control byte, 0x00 for a
  // command and 0x40 for display data. Modelled as two addresses, which is what the control byte
  // effectively is.
  behavior: i2c(0x3c, [
    reg(0x00, 'COMMAND', { access: 'w' }),
    reg(0x40, 'DATA', { access: 'w' }),
  ]),
  limits: { vccMaxVolts: 5.5, vccMinVolts: 3.3, pinMaxAmps: 0.01, totalMaxAmps: 0.03 },
  provenance: builtin([
    'Nothing is rendered. Commands and pixel data are accepted and acknowledged; the framebuffer ' +
      'is not drawn, so the simulated screen never shows what a sketch wrote to it.',
    'Address 0x3C is the common one. Modules strapped for 0x3D exist and will not answer here.',
    'The module carries its own regulator, so 5 V on VCC is fine; the bare controller is 3.3 V.',
  ]),
};

export const LCD1602_I2C: ComponentManifest = {
  schemaVersion: 1,
  id: 'lcd1602-i2c',
  name: 'LCD1602 with I2C Backpack',
  manufacturer: 'Generic',
  partNumber: 'HD44780 + PCF8574',
  category: 'display',
  description: '16x2 character LCD behind a PCF8574 port expander. Four wires instead of twelve.',
  package: { type: 'module', widthMm: 80, heightMm: 36, pinPitchMm: PITCH, bodyColor: '#1a3d2a' },
  pins: row(
    [
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'VCC', model: power(5, { vMin: 4.7, vMax: 5.3, iQuiescent: 0.025 }), description: 'Supply, backlight included' },
      { name: 'SDA', model: digitalIn(5), description: 'I2C data' },
      { name: 'SCL', model: digitalIn(5), description: 'I2C clock' },
    ],
    32,
  ),
  state: [],
  // The PCF8574 has exactly one register: its port. Everything the display does is that byte,
  // written over and over in the HD44780's 4-bit dance.
  behavior: i2c(0x27, [reg(0x00, 'PORT', { reset: 0xff })]),
  limits: { vccMaxVolts: 5.5, vccMinVolts: 4.7, pinMaxAmps: 0.01, totalMaxAmps: 0.04 },
  provenance: builtin([
    'The HD44780 protocol layered on top of the port byte is not decoded, so no characters appear. ' +
      'The bus traffic itself is real.',
    'Address 0x27 is the usual PCF8574 strapping; PCF8574A backpacks answer on 0x3F instead, and ' +
      'that single difference is the commonest reason one of these stays blank.',
    'The 25 mA figure includes the backlight, which is most of it.',
  ]),
};

export const MAX7219: ComponentManifest = {
  schemaVersion: 1,
  id: 'max7219',
  name: 'MAX7219 LED Driver',
  manufacturer: 'Maxim',
  partNumber: 'MAX7219',
  category: 'display',
  description: 'Serially driven 8-digit LED display driver. 8x8 matrix and 7-segment modules.',
  package: { type: 'module', widthMm: 32, heightMm: 32, pinPitchMm: PITCH, bodyColor: '#1a1c20' },
  pins: row(
    [
      { name: 'VCC', model: power(5, { vMin: 4, vMax: 5.5, iQuiescent: 0.33 }), description: 'Supply' },
      { name: 'GND', model: ground(), description: 'Ground' },
      { name: 'DIN', model: digitalIn(5), description: 'Serial data in -- wire to MOSI' },
      { name: 'CS', model: digitalIn(5), description: 'Load, active low -- wire to a chip select' },
      { name: 'CLK', model: digitalIn(5), description: 'Serial clock -- wire to SCK' },
      { name: 'DOUT', model: digitalOut({ sourceMaxA: 0.004, sinkMaxA: 0.004 }), description: 'Serial out, for chaining' },
    ],
    29,
  ),
  state: [],
  // Sixteen-bit frames: an address byte then a data byte. That is `register` addressing exactly,
  // and since every address is 0x00-0x0F the read flag in bit 7 is always clear, which is right --
  // the part is write-only.
  behavior: spi({
    mosiPin: 'DIN',
    misoPin: 'DOUT',
    sckPin: 'CLK',
    csPin: 'CS',
    mode: 0,
    maxClockHz: 10e6,
    addressing: 'register',
    registers: [
      reg(0x01, 'DIGIT0'),
      reg(0x02, 'DIGIT1'),
      reg(0x03, 'DIGIT2'),
      reg(0x04, 'DIGIT3'),
      reg(0x05, 'DIGIT4'),
      reg(0x06, 'DIGIT5'),
      reg(0x07, 'DIGIT6'),
      reg(0x08, 'DIGIT7'),
      reg(0x09, 'DECODE_MODE'),
      reg(0x0a, 'INTENSITY'),
      reg(0x0b, 'SCAN_LIMIT'),
      reg(0x0c, 'SHUTDOWN'),
      reg(0x0f, 'DISPLAY_TEST'),
    ],
  }),
  limits: { vccMaxVolts: 5.5, vccMinVolts: 4, pinMaxAmps: 0.04, totalMaxAmps: 0.33 },
  provenance: builtin([
    'The LEDs are not drawn. Digit registers hold what the sketch wrote, and nothing lights up.',
    'A fully lit 8x8 matrix draws around 320 mA at the default current-set resistor, which is most ' +
      'of a USB budget on its own.',
  ]),
};

/**
 * A single common-cathode digit.
 *
 * Unlike the driven displays above, this one is fully simulated: eight LEDs sharing a cathode is
 * nothing but eight LEDs, so the segments really do light in proportion to their forward current,
 * and driving one straight from eight pins with no series resistors really does over-current them.
 */
export const SEVEN_SEGMENT: ComponentManifest = {
  schemaVersion: 1,
  id: 'seven-segment',
  name: '7-Segment Digit (common cathode)',
  manufacturer: 'Generic',
  partNumber: '5161AS',
  category: 'display',
  description: 'Single-digit display. Eight red LEDs sharing a common cathode.',
  package: { type: 'DIP-10', widthMm: 19, heightMm: 12.7, pinPitchMm: PITCH, bodyColor: '#15181d' },
  pins: [
    ...row(
      [
        { name: 'E', model: led('COM', { color: 'red', vf: 1.9 }), description: 'Segment E' },
        { name: 'D', model: led('COM', { color: 'red', vf: 1.9 }), description: 'Segment D' },
        { name: 'COM', model: ground(), description: 'Common cathode' },
        { name: 'C', model: led('COM', { color: 'red', vf: 1.9 }), description: 'Segment C' },
        { name: 'DP', model: led('COM', { color: 'red', vf: 1.9 }), description: 'Decimal point' },
      ],
      12.7,
    ),
    ...row(
      [
        { name: 'G', model: led('COM', { color: 'red', vf: 1.9 }), description: 'Segment G' },
        { name: 'F', model: led('COM', { color: 'red', vf: 1.9 }), description: 'Segment F' },
        { name: 'COM2', model: ground(), description: 'Common cathode, tied to COM' },
        { name: 'A', model: led('COM', { color: 'red', vf: 1.9 }), description: 'Segment A' },
        { name: 'B', model: led('COM', { color: 'red', vf: 1.9 }), description: 'Segment B' },
      ],
      0,
    ),
  ],
  state: [],
  behavior: { kind: 'passive' },
  limits: { pinMaxAmps: 0.03 },
  provenance: builtin([
    'COM2 is a second cathode pin, tied internally on the real part; here it is an independent ' +
      'ground pin, so a circuit using only one of them behaves the same either way.',
    'Segments are drawn as LEDs on the canvas rather than as a numeral, so the digit shows which ' +
      'segments are lit but not the character they spell.',
  ]),
};

export const DISPLAYS: readonly ComponentManifest[] = [
  SSD1306_OLED,
  LCD1602_I2C,
  MAX7219,
  SEVEN_SEGMENT,
];
