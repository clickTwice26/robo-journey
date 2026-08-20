/**
 * Logic.
 *
 * Thin on purpose. Most of the 74-series does something the archetypes cannot express -- a gate has
 * no register file and no state variable, it just computes -- so what lives here is the family that
 * happens to be addressable: shift registers, which look exactly like a stream-addressed SPI part
 * because that is how everybody drives them.
 */
import type { ComponentManifest } from '../manifest.js';
import { builtin, digitalIn, digitalOut, dip, ground, power, reg, spi } from './kit.js';

const hcIn = (description: string) => ({ model: digitalIn(5), description });
const hcOut = (description: string) => ({
  model: digitalOut({ sourceMaxA: 0.035, sinkMaxA: 0.035 }),
  description,
});

/**
 * The 74HC595, and the one part where `stream` addressing is the whole point.
 *
 * It has no registers and no commands: bytes shift in on SCK and appear on the outputs when the
 * latch pin rises. Modelled with the latch as an active-low chip select, which is exactly how the
 * standard `digitalWrite(latch, LOW); SPI.transfer(x); digitalWrite(latch, HIGH)` idiom drives it,
 * so the byte lands when the latch closes and not before.
 */
export const SHIFT_REGISTER_74HC595: ComponentManifest = {
  schemaVersion: 1,
  id: 'sn74hc595',
  name: '74HC595 Shift Register',
  manufacturer: 'Generic',
  partNumber: 'SN74HC595N',
  category: 'logic',
  description: '8-bit serial-in, parallel-out shift register with output latch.',
  package: { type: 'DIP-16', widthMm: 22, heightMm: 7.62, pinPitchMm: 2.54, bodyColor: '#1a1c20' },
  pins: dip(
    [
      { name: 'QB', ...hcOut('Output 1') },
      { name: 'QC', ...hcOut('Output 2') },
      { name: 'QD', ...hcOut('Output 3') },
      { name: 'QE', ...hcOut('Output 4') },
      { name: 'QF', ...hcOut('Output 5') },
      { name: 'QG', ...hcOut('Output 6') },
      { name: 'QH', ...hcOut('Output 7') },
      { name: 'GND', model: ground(), description: 'Ground, pin 8' },
      { name: 'QH*', ...hcOut('Serial out, for daisy-chaining') },
      { name: 'SRCLR', ...hcIn('Shift register clear, active low') },
      { name: 'SRCLK', ...hcIn('Shift clock -- wire to SCK') },
      { name: 'RCLK', ...hcIn('Latch clock -- acts as chip select') },
      { name: 'OE', ...hcIn('Output enable, active low') },
      { name: 'SER', ...hcIn('Serial data in -- wire to MOSI') },
      { name: 'QA', ...hcOut('Output 0') },
      { name: 'VCC', model: power(5, { vMin: 2, vMax: 6, iQuiescent: 8e-5 }), description: 'Supply, pin 16' },
    ],
    7.62,
  ),
  state: [],
  behavior: spi({
    mosiPin: 'SER',
    misoPin: 'QH*',
    sckPin: 'SRCLK',
    csPin: 'RCLK',
    maxClockHz: 20e6,
    addressing: 'stream',
    registers: [reg(0, 'OUTPUTS')],
  }),
  limits: { vccMaxVolts: 6, vccMinVolts: 2, pinMaxAmps: 0.035, totalMaxAmps: 0.07 },
  provenance: builtin([
    'SRCLR and OE are modelled as ordinary inputs; the shift register always shifts and the ' +
      'outputs are always enabled, so tying them wrong will not be caught.',
    'The QA..QH pins hold the latched byte but do not drive it out, so LEDs wired to them will ' +
      'not light. The bus side is fully simulated.',
  ]),
};

export const LOGIC: readonly ComponentManifest[] = [SHIFT_REGISTER_74HC595];
