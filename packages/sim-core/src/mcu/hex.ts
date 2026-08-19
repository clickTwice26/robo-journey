/**
 * Intel HEX loader.
 *
 * `arduino-cli` emits firmware as Intel HEX, which is what a real programmer streams to the
 * bootloader. We parse the same bytes rather than accepting a pre-digested buffer, so the thing the
 * simulator executes is byte-identical to what would land in flash on a physical board.
 */

/** ATmega328P flash: 32 KiB, addressed by avr8js as 16-bit words. */
export const ATMEGA328P_FLASH_BYTES = 32 * 1024;

export class HexParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`Intel HEX line ${line}: ${message}`);
    this.name = 'HexParseError';
  }
}

const RECORD_DATA = 0x00;
const RECORD_EOF = 0x01;
const RECORD_EXT_SEGMENT_ADDR = 0x02;
const RECORD_EXT_LINEAR_ADDR = 0x04;

/**
 * Parse Intel HEX into a flash image.
 *
 * The checksum on every record is verified. A truncated or corrupted upload that still *looks* like
 * HEX would otherwise execute as garbage instructions and produce a baffling simulation, so it is
 * worth rejecting loudly at the door.
 */
export function parseIntelHex(hex: string, flashBytes = ATMEGA328P_FLASH_BYTES): Uint8Array {
  const flash = new Uint8Array(flashBytes);
  // Unwritten flash reads as 0xFF on real hardware, not 0x00.
  flash.fill(0xff);

  let highAddress = 0;
  let sawEof = false;
  let highestWritten = 0;

  const lines = hex.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]?.trim();
    if (raw === undefined || raw.length === 0) continue;

    const lineNo = i + 1;
    if (!raw.startsWith(':')) throw new HexParseError('record must start with ":"', lineNo);

    const body = raw.slice(1);
    if (body.length % 2 !== 0) throw new HexParseError('odd number of hex digits', lineNo);
    if (!/^[0-9a-fA-F]*$/.test(body)) throw new HexParseError('non-hex character in record', lineNo);

    const bytes = new Uint8Array(body.length / 2);
    for (let b = 0; b < bytes.length; b++) {
      bytes[b] = Number.parseInt(body.slice(b * 2, b * 2 + 2), 16);
    }
    if (bytes.length < 5) throw new HexParseError('record too short', lineNo);

    const byteCount = bytes[0]!;
    const address = (bytes[1]! << 8) | bytes[2]!;
    const recordType = bytes[3]!;

    if (bytes.length !== byteCount + 5) {
      throw new HexParseError(
        `byte count ${byteCount} disagrees with record length ${bytes.length - 5}`,
        lineNo,
      );
    }

    // Checksum is the two's complement of the sum of every preceding byte.
    let sum = 0;
    for (let b = 0; b < bytes.length - 1; b++) sum += bytes[b]!;
    const expected = -sum & 0xff;
    const actual = bytes[bytes.length - 1]!;
    if (expected !== actual) {
      throw new HexParseError(
        `checksum mismatch (expected 0x${expected.toString(16).padStart(2, '0')}, ` +
          `got 0x${actual.toString(16).padStart(2, '0')})`,
        lineNo,
      );
    }

    switch (recordType) {
      case RECORD_DATA: {
        const base = highAddress + address;
        if (base + byteCount > flashBytes) {
          throw new HexParseError(
            `record writes past end of ${flashBytes}-byte flash (address 0x${base.toString(16)})`,
            lineNo,
          );
        }
        flash.set(bytes.subarray(4, 4 + byteCount), base);
        highestWritten = Math.max(highestWritten, base + byteCount);
        break;
      }
      case RECORD_EOF:
        sawEof = true;
        break;
      case RECORD_EXT_SEGMENT_ADDR:
      case RECORD_EXT_LINEAR_ADDR: {
        // Both address records carry exactly two payload bytes. Without this check a truncated
        // record would read its own checksum as the high address byte and silently relocate the
        // rest of the image somewhere absurd - the corrupt-but-parseable case this module exists
        // to reject.
        if (byteCount !== 2) {
          throw new HexParseError(
            `address record must carry 2 bytes, got ${byteCount}`,
            lineNo,
          );
        }
        const value = (bytes[4]! << 8) | bytes[5]!;
        highAddress = recordType === RECORD_EXT_LINEAR_ADDR ? value << 16 : value << 4;
        break;
      }
      default:
        throw new HexParseError(`unsupported record type 0x${recordType.toString(16)}`, lineNo);
    }

    if (sawEof) break;
  }

  if (!sawEof) throw new HexParseError('missing end-of-file record', lines.length);
  if (highestWritten === 0) throw new HexParseError('image contains no program data', lines.length);

  return flash;
}

/** Reinterpret a flash byte image as the little-endian 16-bit word array avr8js executes. */
export function flashToProgMem(flash: Uint8Array): Uint16Array {
  return new Uint16Array(flash.buffer, flash.byteOffset, flash.byteLength >> 1);
}

/** Convenience: Intel HEX text straight to an avr8js program memory image. */
export function loadHex(hex: string, flashBytes = ATMEGA328P_FLASH_BYTES): Uint16Array {
  return flashToProgMem(parseIntelHex(hex, flashBytes));
}
