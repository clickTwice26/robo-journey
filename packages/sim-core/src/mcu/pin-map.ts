/**
 * Arduino Uno <-> ATmega328P pin mapping.
 *
 * Sketches speak in Arduino labels ("D13"), the silkscreen shows those labels, but the emulated
 * hardware only knows ports and bits (PORTB bit 5). Everything above this layer uses the label;
 * everything below uses the port/bit. This table is the only place the two meet.
 */

export type PortId = 'B' | 'C' | 'D';

export interface PinLocation {
  /** Silkscreen label, e.g. "D13" or "A0". */
  readonly label: string;
  readonly port: PortId;
  /** Bit index within the port, 0-7. */
  readonly bit: number;
  /** Physical DIP-28 package pin, for the physical view and for datasheet cross-reference. */
  readonly packagePin: number;
  /** Alternate functions multiplexed onto this pin. */
  readonly functions: readonly string[];
  /** True for pins routed to the ADC multiplexer. */
  readonly analogChannel?: number;
}

/**
 * The Uno's digital and analog headers. Ordered by Arduino pin number so `UNO_PINS[13]` is D13.
 *
 * Note D0/D1 carry the USB serial bridge: wiring anything to them on a real board fights the
 * bootloader, and the fault layer will eventually warn about exactly that.
 */
export const UNO_PINS: readonly PinLocation[] = [
  { label: 'D0', port: 'D', bit: 0, packagePin: 2, functions: ['RXD', 'PCINT16'] },
  { label: 'D1', port: 'D', bit: 1, packagePin: 3, functions: ['TXD', 'PCINT17'] },
  { label: 'D2', port: 'D', bit: 2, packagePin: 4, functions: ['INT0', 'PCINT18'] },
  { label: 'D3', port: 'D', bit: 3, packagePin: 5, functions: ['INT1', 'OC2B', 'PCINT19'] },
  { label: 'D4', port: 'D', bit: 4, packagePin: 6, functions: ['T0', 'XCK', 'PCINT20'] },
  { label: 'D5', port: 'D', bit: 5, packagePin: 11, functions: ['T1', 'OC0B', 'PCINT21'] },
  { label: 'D6', port: 'D', bit: 6, packagePin: 12, functions: ['AIN0', 'OC0A', 'PCINT22'] },
  { label: 'D7', port: 'D', bit: 7, packagePin: 13, functions: ['AIN1', 'PCINT23'] },
  { label: 'D8', port: 'B', bit: 0, packagePin: 14, functions: ['ICP1', 'CLKO', 'PCINT0'] },
  { label: 'D9', port: 'B', bit: 1, packagePin: 15, functions: ['OC1A', 'PCINT1'] },
  { label: 'D10', port: 'B', bit: 2, packagePin: 16, functions: ['SS', 'OC1B', 'PCINT2'] },
  { label: 'D11', port: 'B', bit: 3, packagePin: 17, functions: ['MOSI', 'OC2A', 'PCINT3'] },
  { label: 'D12', port: 'B', bit: 4, packagePin: 18, functions: ['MISO', 'PCINT4'] },
  { label: 'D13', port: 'B', bit: 5, packagePin: 19, functions: ['SCK', 'PCINT5', 'LED_BUILTIN'] },
  { label: 'A0', port: 'C', bit: 0, packagePin: 23, functions: ['ADC0', 'PCINT8'], analogChannel: 0 },
  { label: 'A1', port: 'C', bit: 1, packagePin: 24, functions: ['ADC1', 'PCINT9'], analogChannel: 1 },
  { label: 'A2', port: 'C', bit: 2, packagePin: 25, functions: ['ADC2', 'PCINT10'], analogChannel: 2 },
  { label: 'A3', port: 'C', bit: 3, packagePin: 26, functions: ['ADC3', 'PCINT11'], analogChannel: 3 },
  { label: 'A4', port: 'C', bit: 4, packagePin: 27, functions: ['ADC4', 'SDA', 'PCINT12'], analogChannel: 4 },
  { label: 'A5', port: 'C', bit: 5, packagePin: 28, functions: ['ADC5', 'SCL', 'PCINT13'], analogChannel: 5 },
];

const BY_LABEL = new Map(UNO_PINS.map((p) => [p.label, p]));

/** Look up a pin by silkscreen label ("D13", "A0"). Case-insensitive. */
export function pinByLabel(label: string): PinLocation | undefined {
  return BY_LABEL.get(label.toUpperCase());
}

/** Look up a pin by port and bit, e.g. ('B', 5) -> D13. */
export function pinByPort(port: PortId, bit: number): PinLocation | undefined {
  return UNO_PINS.find((p) => p.port === port && p.bit === bit);
}

/** The on-board LED, which is D13 through a ~1k series resistor on a real Uno. */
export const LED_BUILTIN = 'D13';
