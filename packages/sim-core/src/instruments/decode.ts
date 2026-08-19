/**
 * Protocol decoders.
 *
 * A logic analyser that only draws squiggles tells you a line moved. A decoder tells you it sent
 * `0x48`, and that the stop bit was missing -- which is the difference between seeing a problem and
 * finding one.
 *
 * Decoders work off recorded samples rather than the emulator's internal state on purpose. Reading
 * the USART's transmit register would always agree with itself; reconstructing the byte from the
 * voltage on the wire catches a wrong baud rate, a missing pull-up or a contended bus, because
 * those change the waveform without changing what the peripheral thinks it sent.
 */
import type { ChannelWindow } from './recorder.js';

/** Reconstruct the logic level at an arbitrary time from recorded samples. */
export function levelAt(window: ChannelWindow, time: number, threshold = 0.5): boolean {
  const { times, values } = window;
  if (times.length === 0) return true;
  if (time <= times[0]!) return values[0]! > threshold;

  // Samples are ordered, so a binary search finds the last one at or before `time`.
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (times[mid]! <= time) low = mid;
    else high = mid - 1;
  }
  return values[low]! > threshold;
}

export interface UartFrame {
  /** Time of the start bit's falling edge. */
  readonly startTime: number;
  /** Time the stop bit ends. */
  readonly endTime: number;
  readonly byte: number;
  /** True when the stop bit was not high -- a baud mismatch or a contended line. */
  readonly framingError: boolean;
}

export interface UartOptions {
  readonly baud: number;
  readonly dataBits?: number;
  readonly stopBits?: number;
  /** Voltage above which the line reads as high. */
  readonly threshold?: number;
}

/**
 * Decode asynchronous serial, LSB first.
 *
 * Bits are sampled at their centre, half a bit time in, exactly as a real UART receiver does. That
 * is what makes a wrong baud rate show up as a framing error rather than as silently wrong data:
 * sample in the middle and a mismatched clock walks off the end of the frame.
 */
export function decodeUart(window: ChannelWindow, options: UartOptions): UartFrame[] {
  const { baud } = options;
  if (!(baud > 0)) throw new RangeError(`Baud rate must be positive, got ${baud}`);

  const dataBits = options.dataBits ?? 8;
  const stopBits = options.stopBits ?? 1;
  const threshold = options.threshold ?? 0.5;
  const bitTime = 1 / baud;

  const frames: UartFrame[] = [];
  const { times, values } = window;
  if (times.length === 0) return frames;

  const windowEnd = times[times.length - 1]!;
  let cursor = times[0]!;

  while (cursor < windowEnd) {
    // Find the next falling edge: the line is idle high, and a start bit pulls it low.
    const start = findFallingEdge(window, cursor, threshold);
    if (start === null) break;

    const frameEnd = start + (1 + dataBits + stopBits) * bitTime;
    if (frameEnd > windowEnd) break;

    // A genuine start bit is still low at its centre; a glitch is not.
    if (levelAt(window, start + bitTime * 0.5, threshold)) {
      cursor = start + bitTime * 0.5;
      continue;
    }

    let byte = 0;
    for (let bit = 0; bit < dataBits; bit++) {
      const sampleAt = start + (1.5 + bit) * bitTime;
      if (levelAt(window, sampleAt, threshold)) byte |= 1 << bit;
    }

    const stopAt = start + (1.5 + dataBits) * bitTime;
    const framingError = !levelAt(window, stopAt, threshold);

    frames.push({ startTime: start, endTime: frameEnd, byte, framingError });

    // Re-arm half a bit before the frame ends -- inside the final stop bit -- which is what a real
    // receiver does. Resuming exactly at `frameEnd` misses back-to-back frames, because the next
    // start bit falls at precisely that instant and a strict "after this time" search skips it.
    cursor = frameEnd - bitTime * 0.5;
  }

  return frames;
}

/** First high-to-low transition at or after `from`. */
function findFallingEdge(window: ChannelWindow, from: number, threshold: number): number | null {
  const { times, values } = window;
  let previous = levelAt(window, from, threshold);

  for (let i = 0; i < times.length; i++) {
    if (times[i]! <= from) continue;
    const level = values[i]! > threshold;
    if (previous && !level) return times[i]!;
    previous = level;
  }
  return null;
}

/** Render decoded bytes as printable text, with escapes for anything that is not. */
export function framesToText(frames: readonly UartFrame[]): string {
  return frames
    .map((frame) => {
      if (frame.framingError) return '�';
      const byte = frame.byte;
      if (byte === 0x0a) return '\n';
      if (byte === 0x0d) return '\r';
      if (byte >= 0x20 && byte < 0x7f) return String.fromCharCode(byte);
      return `\\x${byte.toString(16).padStart(2, '0')}`;
    })
    .join('');
}
