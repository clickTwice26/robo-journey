/**
 * M0 gate: the co-simulation spine.
 *
 * Real `arduino-cli` output, executed as machine code on the emulated ATmega328P, observed at the
 * port register. If D13 toggles at 1 Hz here, then the compile -> emulate -> observe path works end
 * to end and M1 can start bolting the analog solver onto it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Atmega328p, UNO_CLOCK_HZ, loadHex } from '../src/index.js';
import type { PinChange } from '../src/index.js';

const blinkHex = readFileSync(
  fileURLToPath(new URL('./fixtures/blink.hex', import.meta.url)),
  'utf8',
);

function runBlink(seconds: number): PinChange[] {
  const mcu = new Atmega328p({ progMem: loadHex(blinkHex) });
  const changes: PinChange[] = [];
  mcu.onPinChange((change) => {
    if (change.pin.label === 'D13') changes.push(change);
  });
  mcu.runFor(seconds);
  return changes;
}

describe('Blink on D13', () => {
  it('shows pinMode driving the pin low before the first digitalWrite', () => {
    const changes = runBlink(0.1);

    // This pair is real hardware behaviour, not an artifact. pinMode(OUTPUT) sets DDRB5 while
    // PORTB5 is still 0, so the pin actively drives LOW for the ~50 cycles until digitalWrite
    // raises it. On a real board that is a genuine glitch on the net, and a circuit that cares
    // (a latch, a MOSFET gate) would see it. The simulator must not smooth it away.
    expect(changes[0]!.state).toBe('low');
    expect(changes[1]!.state).toBe('high');

    const glitchCycles = changes[1]!.cycles - changes[0]!.cycles;
    expect(glitchCycles).toBeGreaterThan(0);
    expect(glitchCycles).toBeLessThan(200);
  });

  it('settles into a strictly alternating square wave', () => {
    const changes = runBlink(2.6);
    expect(changes.length).toBeGreaterThanOrEqual(6);

    // Skip the pinMode glitch; from digitalWrite onward the levels must strictly alternate.
    const steady = changes.slice(1);
    for (let i = 0; i < steady.length; i++) {
      expect(steady[i]!.state).toBe(i % 2 === 0 ? 'high' : 'low');
    }
  });

  it('holds each level for 500 ms, giving a 1 Hz square wave', () => {
    const changes = runBlink(2.6);
    const steady = changes.slice(1);
    const intervals = steady.slice(1).map((c, i) => c.time - steady[i]!.time);

    expect(intervals.length).toBeGreaterThanOrEqual(4);
    for (const interval of intervals) {
      // delay(500) is built on the timer0 millis() tick. A real Uno overshoots by a few
      // microseconds of loop overhead; anything beyond 1 ms means the timer or clock is wrong.
      expect(interval).toBeGreaterThan(0.5);
      expect(interval).toBeLessThan(0.501);
    }
  });

  it('overshoots delay() slightly, the way the Arduino core really does', () => {
    const changes = runBlink(2.6);
    const steady = changes.slice(1);
    const intervals = steady.slice(1).map((c, i) => c.time - steady[i]!.time);

    // Not a rounding artifact: delay() spins until millis() advances, then the loop costs a few
    // more cycles. If this ever became exactly 500.000000 ms, we would have lost fidelity, not
    // gained accuracy.
    for (const interval of intervals) {
      const overshootMicros = (interval - 0.5) * 1e6;
      expect(overshootMicros).toBeGreaterThan(0);
      expect(overshootMicros).toBeLessThan(100);
    }
  });

  it('reports the first edge promptly after reset', () => {
    const changes = runBlink(0.1);
    expect(changes.length).toBeGreaterThan(0);
    // Arduino's init() runs before setup(); it should cost well under a millisecond at 16 MHz.
    expect(changes[0]!.time).toBeLessThan(0.001);
  });

  it('keeps the cycle counter consistent with simulated time', () => {
    const mcu = new Atmega328p({ progMem: loadHex(blinkHex) });
    mcu.runFor(0.25);
    expect(mcu.cycles).toBeGreaterThanOrEqual(0.25 * UNO_CLOCK_HZ);
    expect(mcu.time).toBeCloseTo(mcu.cycles / UNO_CLOCK_HZ, 12);
  });

  it('leaves unrelated pins alone', () => {
    const mcu = new Atmega328p({ progMem: loadHex(blinkHex) });
    const touched = new Set<string>();
    mcu.onPinChange((c) => touched.add(c.pin.label));
    mcu.runFor(1.2);
    // Blink drives exactly one pin. Anything else moving means the port diff is leaking.
    expect([...touched]).toEqual(['D13']);
  });

  it('exposes the same state through pinState() as through the change stream', () => {
    const mcu = new Atmega328p({ progMem: loadHex(blinkHex) });
    let last: PinChange | undefined;
    mcu.onPinChange((c) => {
      if (c.pin.label === 'D13') last = c;
    });
    mcu.runFor(0.25);
    expect(mcu.pinState('D13')).toBe(last?.state);
    expect(mcu.pinState('D13')).toBe('high');
  });
});
