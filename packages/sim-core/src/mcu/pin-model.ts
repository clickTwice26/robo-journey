/**
 * The electrical model of an ATmega328P I/O pin.
 *
 * This file is where "very similar to actual hardware" is either true or it is not. A logic-level
 * simulator says a pin is HIGH or LOW. A real pin is a driver with output impedance, or a resistor
 * to the rail, or very nearly nothing at all -- and what the chip reads back depends on the voltage
 * a whole circuit settles at, not on what the sketch wrote.
 *
 * Every number here is from the ATmega328P datasheet (DS40002061). Where the datasheet gives a
 * range, the typical value is used and the range is quoted in the comment, because a reader
 * checking this against the datasheet deserves to see the same numbers.
 */
import { GROUND, type MnaSystem } from '../analog/mna.js';
import type { Device, StampContext } from '../analog/devices.js';
import type { PinDriveState } from './atmega328p.js';

/**
 * Output driver impedance, ohms.
 *
 * The datasheet publishes this as I/O pin source/sink current curves rather than a resistance;
 * ~25 ohm is the slope at 5 V. It is why a shorted pin delivers a finite ~200 mA rather than
 * infinite current, and why driving many LEDs at once sags each one.
 */
export const OUTPUT_IMPEDANCE_OHMS = 25;

/** Internal pull-up. Datasheet range is 20-50 kOhm; 36k is the typical figure. */
export const PULLUP_OHMS = 36_000;

/**
 * Input leakage path for a tri-stated pin.
 *
 * The datasheet specifies input leakage under 1 uA, which at 5 V is over 5 MOhm. 100 MOhm is
 * chosen so that anything real -- even a 1 MOhm bleeder -- completely dominates it, while still
 * giving the node a defined value instead of floating the matrix.
 */
export const INPUT_IMPEDANCE_OHMS = 100e6;

/** Input logic thresholds as fractions of VCC. VIL max = 0.3 VCC, VIH min = 0.6 VCC. */
export const VIL_FACTOR = 0.3;
export const VIH_FACTOR = 0.6;

/** Absolute maximum DC current per I/O pin, amps. Exceeding this damages the pin. */
export const PIN_ABSOLUTE_MAX_CURRENT = 0.04;

/** Absolute maximum total current through the VCC or GND pin, amps. */
export const SUPPLY_ABSOLUTE_MAX_CURRENT = 0.2;

/** What the input latch reports, including the state a logic simulator cannot represent. */
export type LogicLevel = 'low' | 'high' | 'indeterminate';

/**
 * One I/O pin, as a circuit element.
 *
 * The four drive states map onto three stamps: a resistance to VCC, a resistance to ground, or a
 * very large resistance to ground. That is the whole electrical contract, and it is enough to
 * reproduce brownout, under-driven LEDs, floating inputs and pull-up dividers.
 */
export class AvrPin implements Device {
  readonly branchCount = 0;
  readonly internalNodeCount = 0;
  readonly nonlinear = false;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  /** Updated from the MCU's port registers before each solve. */
  driveState: PinDriveState = 'input';

  /** Level the input latch last reported, held through the hysteresis band. */
  private lastLevel: LogicLevel = 'low';

  constructor(
    readonly id: string,
    /** The circuit node this pin is bonded to. */
    readonly node: number,
    /** The VCC rail node, so a driven-high pin and a pull-up reference the real supply. */
    private readonly vccNode: number,
  ) {
    this.nodes = [node, vccNode];
  }

  reset(): void {
    this.driveState = 'input';
    this.lastLevel = 'low';
  }

  stamp(ctx: StampContext): void {
    switch (this.driveState) {
      case 'high':
        // Driven to the rail through the output transistor's on-resistance.
        ctx.mna.stampConductance(this.node, this.vccNode, 1 / OUTPUT_IMPEDANCE_OHMS);
        break;
      case 'low':
        ctx.mna.stampConductance(this.node, GROUND, 1 / OUTPUT_IMPEDANCE_OHMS);
        break;
      case 'input-pullup':
        ctx.mna.stampConductance(this.node, this.vccNode, 1 / PULLUP_OHMS);
        break;
      case 'input':
        // Not nothing: a real pin leaks. Large enough that any connected part dominates.
        ctx.mna.stampConductance(this.node, GROUND, 1 / INPUT_IMPEDANCE_OHMS);
        break;
    }
  }

  /**
   * Current flowing out of the pin into the circuit, amps. Negative means the pin is sinking.
   *
   * Only meaningful while driving; a high-impedance input passes microamps by definition.
   */
  current(mna: MnaSystem, vcc: number): number {
    const v = mna.voltage(this.node);
    switch (this.driveState) {
      case 'high':
        return (vcc - v) / OUTPUT_IMPEDANCE_OHMS;
      case 'low':
        return -v / OUTPUT_IMPEDANCE_OHMS;
      case 'input-pullup':
        return (vcc - v) / PULLUP_OHMS;
      case 'input':
        return -v / INPUT_IMPEDANCE_OHMS;
    }
  }

  /** True when the pin is driving past its absolute maximum rating. */
  isOverCurrent(mna: MnaSystem, vcc: number): boolean {
    return Math.abs(this.current(mna, vcc)) > PIN_ABSOLUTE_MAX_CURRENT;
  }

  /**
   * What the input latch reads at a given node voltage.
   *
   * The band between VIL and VIH is the interesting part. A logic-level simulator has to pick one,
   * and picking wrong is how a simulator disagrees with a bench. Real inputs are Schmitt-triggered,
   * so the honest answer is: hold the previous level, and separately report that the input is
   * indeterminate so the fault layer can say so out loud.
   */
  readLevel(voltage: number, vcc: number): LogicLevel {
    const vil = VIL_FACTOR * vcc;
    const vih = VIH_FACTOR * vcc;

    if (voltage <= vil) {
      this.lastLevel = 'low';
      return 'low';
    }
    if (voltage >= vih) {
      this.lastLevel = 'high';
      return 'high';
    }
    return 'indeterminate';
  }

  /**
   * The boolean to feed back into the MCU's PIN register.
   *
   * Hysteresis: inside the undefined band the latch holds whatever it last saw, which is what the
   * real Schmitt trigger does and why a slowly-rising input does not chatter.
   */
  latchedLevel(voltage: number, vcc: number): boolean {
    const level = this.readLevel(voltage, vcc);
    if (level === 'indeterminate') return this.lastLevel === 'high';
    return level === 'high';
  }

  /** True when the pin is an input and its voltage sits in the undefined band. */
  isFloating(voltage: number, vcc: number): boolean {
    if (this.driveState !== 'input' && this.driveState !== 'input-pullup') return false;
    const vil = VIL_FACTOR * vcc;
    const vih = VIH_FACTOR * vcc;
    return voltage > vil && voltage < vih;
  }
}
