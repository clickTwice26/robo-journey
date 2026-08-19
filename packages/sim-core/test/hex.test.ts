/**
 * Intel HEX parser.
 *
 * A corrupted image that still parses would execute as garbage instructions and present as a
 * baffling simulation bug, so every rejection path here is worth a test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ATMEGA328P_FLASH_BYTES, HexParseError, loadHex, parseIntelHex } from '../src/index.js';

const blinkHex = readFileSync(
  fileURLToPath(new URL('./fixtures/blink.hex', import.meta.url)),
  'utf8',
);

/** Build a single well-formed data record with a correct checksum. */
function record(address: number, bytes: number[], type = 0x00): string {
  const head = [bytes.length, (address >> 8) & 0xff, address & 0xff, type, ...bytes];
  const checksum = -head.reduce((a, b) => a + b, 0) & 0xff;
  return ':' + [...head, checksum].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

const EOF_RECORD = ':00000001FF';

describe('parseIntelHex', () => {
  it('parses real arduino-cli output', () => {
    const flash = parseIntelHex(blinkHex);
    expect(flash.length).toBe(ATMEGA328P_FLASH_BYTES);
    // First vector is a jump to the reset handler; the Arduino core always emits 0x0C 0x94 here.
    expect(flash[0]).toBe(0x0c);
    expect(flash[1]).toBe(0x94);
  });

  it('leaves unwritten flash at 0xFF, as erased flash really reads', () => {
    const flash = parseIntelHex(record(0x0000, [0x01, 0x02]) + '\n' + EOF_RECORD);
    expect(flash[0]).toBe(0x01);
    expect(flash[1]).toBe(0x02);
    expect(flash[2]).toBe(0xff);
    expect(flash[ATMEGA328P_FLASH_BYTES - 1]).toBe(0xff);
  });

  it('produces little-endian 16-bit words for avr8js', () => {
    const progMem = loadHex(record(0x0000, [0x34, 0x12]) + '\n' + EOF_RECORD);
    expect(progMem[0]).toBe(0x1234);
  });

  it('honours extended linear address records', () => {
    // A 0x0000 linear base keeps the following record at its stated address.
    const hex = [record(0x0000, [0x00, 0x00], 0x04), record(0x0010, [0x42]), EOF_RECORD].join('\n');
    expect(parseIntelHex(hex)[0x10]).toBe(0x42);
  });

  it('rejects an address record with the wrong payload length', () => {
    // One byte instead of two: the checksum would otherwise be read as address data.
    const hex = [record(0x0000, [0xaa], 0x04), EOF_RECORD].join('\n');
    expect(() => parseIntelHex(hex)).toThrow(/address record must carry 2 bytes/);
  });

  it('tolerates blank lines and CRLF', () => {
    const hex = ['', record(0x0000, [0x7f]), '', EOF_RECORD, ''].join('\r\n');
    expect(parseIntelHex(hex)[0]).toBe(0x7f);
  });

  it('rejects a bad checksum', () => {
    const good = record(0x0000, [0x01, 0x02]);
    const corrupted = good.slice(0, -2) + '00';
    expect(() => parseIntelHex(corrupted + '\n' + EOF_RECORD)).toThrow(HexParseError);
    expect(() => parseIntelHex(corrupted + '\n' + EOF_RECORD)).toThrow(/checksum mismatch/);
  });

  it('rejects a byte count that disagrees with the payload', () => {
    // Claims 8 data bytes, supplies 2.
    expect(() => parseIntelHex(':080000000102' + '\n' + EOF_RECORD)).toThrow(/byte count|too short/);
  });

  it('rejects a missing end-of-file record', () => {
    expect(() => parseIntelHex(record(0x0000, [0x01]))).toThrow(/end-of-file/);
  });

  it('rejects a record that overruns flash', () => {
    // Linear base 0x0001 puts the payload at 0x10000, past the end of 32 KiB of flash.
    const hex = [record(0x0000, [0x00, 0x01], 0x04), record(0x0000, [0x01]), EOF_RECORD];
    expect(() => parseIntelHex(hex.join('\n'))).toThrow(/past end of/);
  });

  it('rejects non-hex characters and malformed records', () => {
    expect(() => parseIntelHex(':00ZZ0001FF\n' + EOF_RECORD)).toThrow(/non-hex/);
    expect(() => parseIntelHex('0000001FF\n' + EOF_RECORD)).toThrow(/must start with/);
    expect(() => parseIntelHex(':0000000\n' + EOF_RECORD)).toThrow(/odd number/);
  });

  it('rejects an image with no program data', () => {
    expect(() => parseIntelHex(EOF_RECORD)).toThrow(/no program data/);
  });

  it('reports the offending line number', () => {
    const hex = [record(0x0000, [0x01]), ':FFFFFFFFFF', EOF_RECORD].join('\n');
    try {
      parseIntelHex(hex);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HexParseError);
      expect((err as HexParseError).line).toBe(2);
    }
  });
});
