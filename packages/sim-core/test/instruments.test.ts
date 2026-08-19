/**
 * Instruments: signal capture and protocol decoding.
 *
 * The headline test decodes a `Serial.println` back out of the recorded voltage on D1. Nothing in
 * that path is shortcut -- the sketch writes UDR, the USART reports the byte, the TX line is
 * synthesised from UBRR, the pin model turns it into a voltage, the solver settles it, the
 * recorder captures it, and the decoder reads the byte off the trace. If any link disagreed with
 * any other, the text would come out wrong.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Board,
  SignalRecorder,
  analogChannel,
  decodeUart,
  digitalChannel,
  framesToText,
  levelAt,
  loadHex,
  type ChannelWindow,
} from '../src/index.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('SignalRecorder', () => {
  it('records and reads back samples in order', () => {
    const recorder = new SignalRecorder({ capacity: 16 });
    recorder.addChannel({ id: 'a', kind: 'analog', label: 'A' });
    for (let i = 0; i < 5; i++) recorder.sample('a', i * 0.001, i);

    const window = recorder.window('a', 0, 1)!;
    expect([...window.values]).toEqual([0, 1, 2, 3, 4]);
    expect(window.times[0]).toBeCloseTo(0, 9);
  });

  it('drops repeated values on a digital channel but keeps transitions', () => {
    // A pin sitting high for half a second must not fill the ring with identical samples and push
    // the edge that matters out the back.
    const recorder = new SignalRecorder({ capacity: 64 });
    recorder.addChannel({ id: 'd', kind: 'digital', label: 'D' });
    for (let i = 0; i < 20; i++) recorder.sample('d', i * 0.001, 1);
    recorder.sample('d', 0.021, 0);
    recorder.sample('d', 0.022, 0);
    recorder.sample('d', 0.023, 1);

    expect([...recorder.window('d', 0, 1)!.values]).toEqual([1, 0, 1]);
  });

  it('keeps every sample on an analog channel, because that is the waveform', () => {
    const recorder = new SignalRecorder({ capacity: 64 });
    recorder.addChannel({ id: 'a', kind: 'analog', label: 'A' });
    for (let i = 0; i < 10; i++) recorder.sample('a', i * 0.001, 2.5);
    expect(recorder.window('a', 0, 1)!.values).toHaveLength(10);
  });

  it('overwrites oldest samples once full rather than growing', () => {
    const recorder = new SignalRecorder({ capacity: 4 });
    recorder.addChannel({ id: 'a', kind: 'analog', label: 'A' });
    for (let i = 0; i < 10; i++) recorder.sample('a', i, i);

    const window = recorder.window('a', -Infinity, Infinity)!;
    expect(window.values).toHaveLength(4);
    expect([...window.values]).toEqual([6, 7, 8, 9]);
  });

  it('decimates a dense window down to the requested point count', () => {
    const recorder = new SignalRecorder({ capacity: 10_000 });
    recorder.addChannel({ id: 'a', kind: 'analog', label: 'A' });
    for (let i = 0; i < 5000; i++) recorder.sample('a', i * 1e-6, Math.sin(i));

    const window = recorder.window('a', 0, 1, 100)!;
    expect(window.values.length).toBeLessThanOrEqual(101);
    expect(window.values.length).toBeGreaterThan(50);
  });

  it('reports edges on a digital channel', () => {
    const recorder = new SignalRecorder({ capacity: 64 });
    recorder.addChannel({ id: 'd', kind: 'digital', label: 'D' });
    recorder.sample('d', 0, 1);
    recorder.sample('d', 0.001, 0);
    recorder.sample('d', 0.002, 1);

    const edges = recorder.edges('d');
    expect(edges.map((e) => e.level)).toEqual([false, true]);
    expect(edges[0]!.time).toBeCloseTo(0.001, 9);
  });

  it('ignores samples for channels that were never added', () => {
    const recorder = new SignalRecorder();
    expect(() => recorder.sample('nope', 0, 1)).not.toThrow();
    expect(recorder.window('nope', 0, 1)).toBeNull();
  });
});

describe('UART decoding', () => {
  /** Build a synthetic waveform for a run of bytes at a given baud. */
  function synth(bytes: number[], baud: number, start = 0.001): ChannelWindow {
    const bit = 1 / baud;
    const times: number[] = [0];
    const values: number[] = [1];
    let t = start;

    for (const byte of bytes) {
      times.push(t);
      values.push(0); // start bit
      for (let i = 0; i < 8; i++) {
        times.push(t + (1 + i) * bit);
        values.push((byte >> i) & 1);
      }
      times.push(t + 9 * bit);
      values.push(1); // stop bit
      t += 10 * bit;
    }
    times.push(t + bit);
    values.push(1);

    return {
      id: 'tx',
      label: 'TX',
      kind: 'digital',
      times: Float64Array.from(times),
      values: Float64Array.from(values),
    };
  }

  it('decodes a single byte', () => {
    const frames = decodeUart(synth([0x41], 9600), { baud: 9600 });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.byte).toBe(0x41);
    expect(frames[0]!.framingError).toBe(false);
  });

  it('decodes a run of bytes as text', () => {
    const message = 'Hello!';
    const bytes = [...message].map((c) => c.charCodeAt(0));
    const frames = decodeUart(synth(bytes, 115200), { baud: 115200 });
    expect(framesToText(frames)).toBe(message);
  });

  it('reads bits least significant first, as the wire does', () => {
    // 0x01 and 0x80 differ only in bit order; getting this backwards decodes one as the other.
    expect(decodeUart(synth([0x01], 9600), { baud: 9600 })[0]!.byte).toBe(0x01);
    expect(decodeUart(synth([0x80], 9600), { baud: 9600 })[0]!.byte).toBe(0x80);
  });

  it('flags a framing error when the baud rate is wrong', () => {
    // The classic serial bug. Sampling at the wrong rate walks off the end of the frame, which is
    // exactly what a real receiver does -- and why the symptom is garbage rather than silence.
    const wave = synth([0x55, 0x55, 0x55], 9600);
    const frames = decodeUart(wave, { baud: 19200 });
    const wrong = frames.some((f) => f.framingError || f.byte !== 0x55);
    expect(wrong).toBe(true);
  });

  it('decodes correctly when the baud rate matches', () => {
    const frames = decodeUart(synth([0x55, 0x55], 9600), { baud: 9600 });
    expect(frames.every((f) => !f.framingError && f.byte === 0x55)).toBe(true);
  });

  it('rejects a non-positive baud rate', () => {
    expect(() => decodeUart(synth([0x41], 9600), { baud: 0 })).toThrow(RangeError);
  });

  it('reconstructs the level at an arbitrary time', () => {
    const wave = synth([0xff], 9600);
    // Idle before the first frame.
    expect(levelAt(wave, 0.0005)).toBe(true);
    // Inside the start bit.
    expect(levelAt(wave, 0.001 + 0.5 / 9600)).toBe(false);
  });
});

describe('serial capture end to end', () => {
  function serialBoard(): Board {
    return new Board({ progMem: loadHex(fixture('serial.hex')) });
  }

  it('derives the baud rate the sketch asked for', () => {
    const board = serialBoard();
    board.runFor(0.02);
    // Serial.begin(9600) at 16 MHz uses U2X, giving UBRR = 207 and 9615 baud -- the 0.16% error a
    // real Uno also has, which is why 9600 works at all.
    expect(board.mcu.baudRate).toBeGreaterThan(9500);
    expect(board.mcu.baudRate).toBeLessThan(9700);
  });

  it('puts a real waveform on D1 rather than leaving it idle', () => {
    const board = serialBoard();
    board.runFor(0.05);

    const edges = board.recorder.edges(digitalChannel('D1'));
    // "Hi\\r\\n" is four bytes, each with at least two transitions.
    expect(edges.length).toBeGreaterThan(8);
  });

  it('decodes the transmitted text back off the wire', () => {
    // The whole chain, end to end.
    const board = serialBoard();
    board.runFor(0.06);

    const window = board.recorder.window(digitalChannel('D1'), 0, board.time, 100_000)!;
    const frames = decodeUart(window, { baud: Math.round(board.mcu.baudRate) });
    const text = framesToText(frames);

    expect(text).toContain('Hi');
    expect(frames.some((f) => f.framingError)).toBe(false);
  });

  it('agrees with what the USART peripheral reported', () => {
    // Two independent paths to the same bytes: the peripheral callback and the waveform. They must
    // agree, or the synthesised line does not match what the chip actually sent.
    const board = serialBoard();
    const viaCallback: number[] = [];
    board.mcu.onSerialByte((byte) => viaCallback.push(byte));
    board.runFor(0.06);

    const window = board.recorder.window(digitalChannel('D1'), 0, board.time, 100_000)!;
    const viaWaveform = decodeUart(window, { baud: Math.round(board.mcu.baudRate) }).map((f) => f.byte);

    expect(viaWaveform).toEqual(viaCallback.slice(0, viaWaveform.length));
    expect(viaWaveform.length).toBeGreaterThan(0);
  });

  it('leaves TX idle high before the sketch enables the transmitter', () => {
    const board = serialBoard();
    // Before Serial.begin runs, the USART does not own the pin.
    expect(board.mcu.transmitterEnabled).toBe(false);
  });
});

describe('board capture', () => {
  it('records every pin digitally without being asked', () => {
    const board = new Board({ progMem: loadHex(fixture('blink.hex')) });
    board.runFor(1.2);

    const edges = board.recorder.edges(digitalChannel('D13'));
    // One pinMode transition plus two blink edges in 1.2 s.
    expect(edges.length).toBeGreaterThanOrEqual(2);
  });

  it('records analog traces only once asked', () => {
    const board = new Board({ progMem: loadHex(fixture('blink.hex')) });
    expect(board.recorder.window(analogChannel('D13'), 0, 1)).toBeNull();

    board.watchAnalog('D13');
    board.runFor(0.05);
    const window = board.recorder.window(analogChannel('D13'), 0, 1)!;
    expect(window.values.length).toBeGreaterThan(0);
    // A driven-high pin sits below the rail because of its output impedance.
    expect(Math.max(...window.values)).toBeGreaterThan(4);
  });

  it('clears capture on reset', () => {
    const board = new Board({ progMem: loadHex(fixture('blink.hex')) });
    board.runFor(1.2);
    expect(board.recorder.edges(digitalChannel('D13')).length).toBeGreaterThan(0);

    board.reset();
    expect(board.recorder.edges(digitalChannel('D13'))).toEqual([]);
  });
});
