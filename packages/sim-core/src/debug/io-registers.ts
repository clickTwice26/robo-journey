/**
 * I/O register names for the ATmega328P.
 *
 * A disassembly reading `out 0x05, r24` tells you almost nothing; `out PORTB, r24` tells you the
 * sketch just wrote a pin. The annotation is the difference between a listing you can read and one
 * you have to decode with the datasheet open.
 *
 * Two address spaces are involved and confusing them is a classic mistake: `IN`/`OUT` use the 0x00
 * to 0x3F I/O space, while `LDS`/`STS` and the memory-mapped view use data space, which is the I/O
 * address plus 0x20. Both are listed, keyed by their own space.
 */

/** Names in I/O space (0x00-0x3F), as used by IN, OUT, SBI, CBI, SBIS and SBIC. */
export const IO_SPACE: Record<number, string> = {
  0x03: 'PINB', 0x04: 'DDRB', 0x05: 'PORTB',
  0x06: 'PINC', 0x07: 'DDRC', 0x08: 'PORTC',
  0x09: 'PIND', 0x0a: 'DDRD', 0x0b: 'PORTD',
  0x15: 'TIFR0', 0x16: 'TIFR1', 0x17: 'TIFR2',
  0x1b: 'PCIFR', 0x1c: 'EIFR', 0x1d: 'EIMSK',
  0x1e: 'GPIOR0', 0x1f: 'EECR', 0x20: 'EEDR',
  0x21: 'EEARL', 0x22: 'EEARH', 0x23: 'GTCCR',
  0x24: 'TCCR0A', 0x25: 'TCCR0B', 0x26: 'TCNT0',
  0x27: 'OCR0A', 0x28: 'OCR0B',
  0x2a: 'GPIOR1', 0x2b: 'GPIOR2', 0x2c: 'SPCR',
  0x2d: 'SPSR', 0x2e: 'SPDR', 0x30: 'ACSR',
  0x33: 'SMCR', 0x34: 'MCUSR', 0x35: 'MCUCR',
  0x37: 'SPMCSR', 0x3d: 'SPL', 0x3e: 'SPH', 0x3f: 'SREG',
};

/** Names in data space, for LDS/STS and the memory-mapped registers above 0x5F. */
export const DATA_SPACE: Record<number, string> = {
  0x60: 'WDTCSR', 0x61: 'CLKPR', 0x64: 'PRR',
  0x66: 'OSCCAL', 0x68: 'PCICR', 0x69: 'EICRA',
  0x6b: 'PCMSK0', 0x6c: 'PCMSK1', 0x6d: 'PCMSK2',
  0x6e: 'TIMSK0', 0x6f: 'TIMSK1', 0x70: 'TIMSK2',
  0x78: 'ADCL', 0x79: 'ADCH', 0x7a: 'ADCSRA',
  0x7b: 'ADCSRB', 0x7c: 'ADMUX', 0x7e: 'DIDR0', 0x7f: 'DIDR1',
  0x80: 'TCCR1A', 0x81: 'TCCR1B', 0x82: 'TCCR1C',
  0x84: 'TCNT1L', 0x85: 'TCNT1H', 0x86: 'ICR1L', 0x87: 'ICR1H',
  0x88: 'OCR1AL', 0x89: 'OCR1AH', 0x8a: 'OCR1BL', 0x8b: 'OCR1BH',
  0xb0: 'TCCR2A', 0xb1: 'TCCR2B', 0xb2: 'TCNT2',
  0xb3: 'OCR2A', 0xb4: 'OCR2B', 0xb6: 'ASSR',
  0xb8: 'TWBR', 0xb9: 'TWSR', 0xba: 'TWAR', 0xbb: 'TWDR', 0xbc: 'TWCR', 0xbd: 'TWAMR',
  0xc0: 'UCSR0A', 0xc1: 'UCSR0B', 0xc2: 'UCSR0C',
  0xc4: 'UBRR0L', 0xc5: 'UBRR0H', 0xc6: 'UDR0',
};

/** Name for an I/O-space address, or undefined when it has no documented name. */
export function ioName(address: number): string | undefined {
  return IO_SPACE[address];
}

/**
 * Name for a data-space address.
 *
 * Falls back to the I/O-space table shifted by 0x20, because the low registers are visible in both
 * and the datasheet names them once.
 */
export function dataName(address: number): string | undefined {
  return DATA_SPACE[address] ?? (address >= 0x20 && address < 0x60 ? IO_SPACE[address - 0x20] : undefined);
}
