/**
 * The USART's transmit line.
 *
 * avr8js models the USART behaviourally: it reports the byte written to UDR and schedules the
 * completion interrupt, but never touches the TX pin. That is fine for a serial monitor and wrong
 * for everything else -- a logic analyser sees a dead line, and the most common serial bug of all,
 * a baud rate that does not match, becomes invisible because nothing is on the wire to mismatch.
 *
 * So the waveform is synthesised here from the same numbers the peripheral uses: the frame starts
 * when UDR is written, and the bit period comes from UBRR and the U2X multiplier, exactly as the
 * hardware derives it. A sketch calling `Serial.begin(9600)` really does put 104 us bits on D1.
 */

interface Frame {
  /** CPU cycle the start bit begins. */
  readonly startCycle: number;
  /** Cycles per bit. */
  readonly bitCycles: number;
  /** Total bits in the frame: start + data + parity + stop. */
  readonly totalBits: number;
  /** Levels for each bit, index 0 being the start bit. */
  readonly bits: readonly boolean[];
}

export class UsartTxLine {
  private readonly queue: Frame[] = [];
  /** Cycle at which the last queued frame finishes, so back-to-back bytes do not overlap. */
  private busyUntil = 0;

  /**
   * Queue a byte for transmission.
   *
   * @param byte Value written to UDR.
   * @param nowCycle Cycle of the write.
   * @param bitCycles Cycles per bit, from UBRR and the speed multiplier.
   * @param dataBits Character size, normally 8.
   */
  transmit(byte: number, nowCycle: number, bitCycles: number, dataBits = 8): void {
    if (!(bitCycles > 0)) return;

    // A frame cannot start before the previous one has finished shifting out. The Arduino core
    // waits on UDRE so this rarely bites, but a sketch writing UDR directly can outrun the line.
    const startCycle = Math.max(nowCycle, this.busyUntil);

    const bits: boolean[] = [false]; // start bit: the line is pulled low
    for (let i = 0; i < dataBits; i++) bits.push((byte & (1 << i)) !== 0); // LSB first
    bits.push(true); // stop bit returns the line to idle

    const frame: Frame = { startCycle, bitCycles, totalBits: bits.length, bits };
    this.queue.push(frame);
    this.busyUntil = startCycle + bits.length * bitCycles;

    // Bound the queue: a sketch printing in a tight loop for an hour must not accumulate frames
    // that have long since been transmitted.
    this.prune(nowCycle);
  }

  /** True while a frame is being shifted out at the given cycle. */
  isActive(cycle: number): boolean {
    return this.frameAt(cycle) !== null;
  }

  /**
   * Line level at a given cycle. Idle is high, which is why a disconnected UART reads as a stream
   * of framing errors rather than as silence.
   */
  levelAt(cycle: number): boolean {
    const frame = this.frameAt(cycle);
    if (!frame) return true;

    const bit = Math.floor((cycle - frame.startCycle) / frame.bitCycles);
    return frame.bits[bit] ?? true;
  }

  /** Cycle at which the current or next frame changes level, for scheduling a re-solve. */
  nextEdgeCycle(cycle: number): number | null {
    for (const frame of this.queue) {
      const end = frame.startCycle + frame.totalBits * frame.bitCycles;
      if (end <= cycle) continue;
      if (cycle < frame.startCycle) return frame.startCycle;
      const bit = Math.floor((cycle - frame.startCycle) / frame.bitCycles);
      return frame.startCycle + (bit + 1) * frame.bitCycles;
    }
    return null;
  }

  reset(): void {
    this.queue.length = 0;
    this.busyUntil = 0;
  }

  private frameAt(cycle: number): Frame | null {
    for (const frame of this.queue) {
      const end = frame.startCycle + frame.totalBits * frame.bitCycles;
      if (cycle >= frame.startCycle && cycle < end) return frame;
    }
    return null;
  }

  private prune(nowCycle: number): void {
    while (this.queue.length > 0) {
      const frame = this.queue[0]!;
      if (frame.startCycle + frame.totalBits * frame.bitCycles >= nowCycle) break;
      this.queue.shift();
    }
  }
}
