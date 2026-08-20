/**
 * Meters: instruments as real circuit elements.
 *
 * The point of these is that they are *in* the circuit rather than beside it. A voltmeter is ten
 * megohms across two nodes, an ammeter is a resistor in series, and both of those change the thing
 * they measure -- slightly, usually, and decisively when the circuit is high-impedance or the
 * meter is on the wrong range. Reading a node voltage out of the solver and calling it a
 * measurement would hide every one of those effects, and they are the ones that catch people out:
 *
 *   - Ten megohms across a floating pin pulls it somewhere definite, so the meter reads a voltage
 *     that was not there before the probe touched it.
 *   - An ammeter's shunt drops a real voltage. On the milliamp range that burden can be a
 *     meaningful fraction of a 5 V supply, which is why a marginal circuit sometimes stops working
 *     the moment you try to measure its current.
 *   - The current jacks are a near short. Putting them across a supply is the single commonest way
 *     a multimeter dies, and it dies here too: the fuse blows, the meter goes open circuit, and it
 *     stays that way until you reset.
 *
 * An ohmmeter works by pushing a known current through the unknown and measuring what comes back,
 * so it is only meaningful on a circuit with nothing else driving it -- which is why every
 * datasheet and every manual says to power the board down first. That is modelled rather than
 * excused: measure a live circuit and the reading is nonsense, and the meter says so.
 */
import type { Device, DeviceReadout, StampContext } from '../analog/devices.js';

/** What the rotary switch is pointing at. */
export type MeterMode = 'volts' | 'amps' | 'ohms';

/** Which current jack the lead is in. */
export type CurrentRange = 'mA' | 'A';

/** Input impedance of a decent digital voltmeter. */
export const VOLTMETER_OHMS = 10e6;

/**
 * Shunt resistance and fuse rating per current range.
 *
 * The milliamp jack trades burden voltage for resolution -- an ohm of shunt is 200 mV at full
 * scale -- and the amp jack does the opposite. Both are fused, and the milliamp fuse is the one
 * that actually blows.
 */
const RANGES: Record<CurrentRange, { shuntOhms: number; fuseAmps: number }> = {
  mA: { shuntOhms: 1, fuseAmps: 0.2 },
  A: { shuntOhms: 0.01, fuseAmps: 10 },
};

/** Open circuit once a fuse has gone: not infinite, because the matrix has to stay solvable. */
const BLOWN_OHMS = 1e9;

/**
 * The ohmmeter's test source: an open-circuit voltage behind a series resistance.
 *
 * A real one runs from the meter's own battery, so it has a limit on both what it can push and how
 * hard. Modelling it as a source with compliance rather than as an ideal current source is what
 * makes the range behave: the terminals sit at the full 3 V on an open circuit and fall toward
 * zero on a short, and the resistance is read back off where between the two they land.
 *
 * The pair below give a milliamp into a dead short, which is what a hand-held meter delivers.
 */
const OHMMETER_SOURCE_VOLTS = 3;
const OHMMETER_SOURCE_OHMS = 3000;

/** Beyond this the meter is looking at an open circuit, which every DMM shows as `OL`. */
const OVERRANGE_OHMS = 50e6;

// ---------------------------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------------------------

/**
 * A reading the way a four-digit autoranging meter shows it.
 *
 * Significant figures rather than decimal places, because that is what a real display does and it
 * is the difference between `0.00 V` and `4.85 mV` for the same number.
 */
export function formatReading(value: number, unit: string): string {
  const abs = Math.abs(value);
  if (!Number.isFinite(value)) return `OL ${unit}`;

  const scales: [number, string][] = [
    [1e6, 'M'],
    [1e3, 'k'],
    [1, ''],
    [1e-3, 'm'],
    [1e-6, 'u'],
  ];

  if (abs < 1e-6) return `0.000 ${unit}`;

  for (const [factor, prefix] of scales) {
    if (abs >= factor) {
      const scaled = value / factor;
      // Four digits total, the way a 3.5-digit meter allocates them.
      const decimals = Math.abs(scaled) >= 100 ? 1 : Math.abs(scaled) >= 10 ? 2 : 3;
      return `${scaled.toFixed(decimals)} ${prefix}${unit}`;
    }
  }
  return `${value.toExponential(2)} ${unit}`;
}

// ---------------------------------------------------------------------------------------------

/**
 * A current shunt with a fuse, shared by the ammeter and the multimeter's current ranges.
 *
 * Kept as its own object because the fuse is the interesting part and it should behave identically
 * whichever instrument is holding it.
 */
class Shunt {
  blown = false;
  amps = 0;

  constructor(public range: CurrentRange) {}

  get ohms(): number {
    return this.blown ? BLOWN_OHMS : RANGES[this.range].shuntOhms;
  }

  get fuseAmps(): number {
    return RANGES[this.range].fuseAmps;
  }

  /**
   * Latch the measurement, and optionally the fuse.
   *
   * The fuse is only decided on a converged solve. A value read mid-transient is a number the
   * circuit never actually reached, and blowing a fuse on one would be a failure nobody could
   * account for.
   */
  update(dropVolts: number, checkFuse: boolean): void {
    if (this.blown) {
      this.amps = 0;
      return;
    }
    this.amps = dropVolts / RANGES[this.range].shuntOhms;
    if (checkFuse && Math.abs(this.amps) > this.fuseAmps) this.blown = true;
  }

  reset(): void {
    this.blown = false;
    this.amps = 0;
  }
}

// ---------------------------------------------------------------------------------------------

export interface AmmeterOptions {
  readonly range?: CurrentRange;
  /**
   * Start with the fuse already gone.
   *
   * A property change rebuilds the circuit, so without this a blown fuse would quietly repair
   * itself the moment anything else on the bench was touched -- which is not how fuses work, and
   * blowing one is a lesson worth keeping.
   */
  readonly blown?: boolean;
}

/**
 * An in-line ammeter.
 *
 * Two terminals, wired in series with whatever is being measured -- there is no way to use one
 * without breaking the circuit open, and that is deliberate. A current meter you could clip across
 * a component would teach the wrong instinct, and clipping this one across anything low-impedance
 * blows its fuse, exactly as it would on the bench.
 */
export class Ammeter implements Device {
  readonly branchCount = 0;
  readonly internalNodeCount = 0;
  readonly nonlinear = false;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  private readonly shunt: Shunt;

  constructor(
    readonly id: string,
    private readonly a: number,
    private readonly b: number,
    options: AmmeterOptions = {},
  ) {
    this.nodes = [a, b];
    this.shunt = new Shunt(options.range ?? 'mA');
    this.shunt.blown = options.blown === true;
  }

  /** Measured current, amps. Positive flowing in at the first terminal. */
  get amps(): number {
    return this.shunt.amps;
  }

  get blown(): boolean {
    return this.shunt.blown;
  }

  get burdenVolts(): number {
    return this.shunt.amps * RANGES[this.shunt.range].shuntOhms;
  }

  set range(range: CurrentRange) {
    this.shunt.range = range;
  }

  stamp(ctx: StampContext): void {
    // A DC operating point never reaches `commit`, so the display would sit at zero for a circuit
    // that is not being stepped through time. Refresh from the previous operating point instead;
    // the fuse still waits for a converged solve.
    if (ctx.firstIteration && ctx.timestep <= 0) {
      this.shunt.update(ctx.voltage(this.a) - ctx.voltage(this.b), false);
    }
    ctx.mna.stampResistance(this.a, this.b, this.shunt.ohms);
  }

  commit(ctx: StampContext): void {
    this.shunt.update(ctx.voltage(this.a) - ctx.voltage(this.b), true);
  }

  readout(): DeviceReadout[] {
    if (this.shunt.blown) {
      return [
        { label: 'Reading', value: 'FUSE', alarm: true },
        {
          label: 'Fuse',
          value: `blown above ${formatReading(this.shunt.fuseAmps, 'A')}`,
          alarm: true,
        },
      ];
    }
    return [
      { label: 'Reading', value: formatReading(this.shunt.amps, 'A') },
      { label: 'Range', value: `${this.shunt.range} (fuse ${formatReading(this.shunt.fuseAmps, 'A')})` },
      // The voltage the meter itself is stealing from the circuit. Small, until it is not.
      { label: 'Burden', value: formatReading(this.burdenVolts, 'V') },
    ];
  }

  reset(): void {
    this.shunt.reset();
  }
}

// ---------------------------------------------------------------------------------------------

export interface MultimeterOptions {
  readonly mode?: MeterMode;
  readonly range?: CurrentRange;
  /** Start with the fuse already gone. See `AmmeterOptions.blown`. */
  readonly blown?: boolean;
}

/**
 * A three-jack digital multimeter.
 *
 * Modelled as one instrument with a switch rather than as three separate meters, because which
 * jack the lead is in is half of what there is to get wrong. The V/ohm jack and the A jack are
 * both live at once here, as they are on a real meter -- so a lead left in the current jack while
 * the dial reads volts is still a near short across whatever it touches.
 */
export class Multimeter implements Device {
  readonly branchCount = 0;
  readonly internalNodeCount = 0;
  readonly nonlinear = false;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  private mode: MeterMode;
  private readonly shunt: Shunt;
  private volts = 0;
  /** Voltage the ohms range is developing across the unknown. */
  private ohmsVolts = 0;

  constructor(
    readonly id: string,
    /** The V/ohm jack. */
    private readonly vNode: number,
    /** The COM jack, which every measurement is referenced to. */
    private readonly comNode: number,
    /** The current jack. */
    private readonly aNode: number,
    options: MultimeterOptions = {},
  ) {
    this.nodes = [vNode, comNode, aNode];
    this.mode = options.mode ?? 'volts';
    this.shunt = new Shunt(options.range ?? 'mA');
    this.shunt.blown = options.blown === true;
  }

  setMode(mode: MeterMode): void {
    this.mode = mode;
  }

  setRange(range: CurrentRange): void {
    this.shunt.range = range;
  }

  /** What the display shows, in the unit for the current mode. */
  get reading(): number {
    switch (this.mode) {
      case 'volts':
        return this.volts;
      case 'amps':
        return this.shunt.amps;
      case 'ohms':
        return this.resistance;
    }
  }

  /**
   * The unknown, read back from where the terminals settled.
   *
   * The test source and the unknown form a divider, so inverting it gives the resistance:
   * `V = Vs * R / (R + Rs)` rearranges to `R = Rs * V / (Vs - V)`. As the unknown grows the
   * denominator vanishes, which is over-range arriving on its own rather than by a threshold.
   */
  private get resistance(): number {
    const headroom = OHMMETER_SOURCE_VOLTS - this.ohmsVolts;
    if (headroom <= 0) return Infinity;
    const ohms = (OHMMETER_SOURCE_OHMS * this.ohmsVolts) / headroom;
    return ohms > OVERRANGE_OHMS ? Infinity : Math.max(0, ohms);
  }

  /**
   * True when something else is driving the terminals, so an ohms reading means nothing.
   *
   * The test source cannot pull its terminals past its own open-circuit voltage or below its own
   * ground, so a reading outside that window is not the meter's doing.
   */
  private get liveCircuit(): boolean {
    if (this.mode !== 'ohms') return false;
    return this.ohmsVolts > OHMMETER_SOURCE_VOLTS * 1.02 || this.ohmsVolts < -0.05;
  }

  stamp(ctx: StampContext): void {
    // See `Ammeter.stamp`: a DC-only solve has no commit to latch after.
    if (ctx.firstIteration && ctx.timestep <= 0) this.measure(ctx, false);

    // The current jack is always connected, whatever the dial says. That is what makes leaving a
    // lead in it dangerous, and the simulation should not be safer than the bench.
    ctx.mna.stampResistance(this.aNode, this.comNode, this.shunt.ohms);

    if (this.mode === 'ohms') {
      // The meter's own test source, as its Norton equivalent -- no branch unknown, same circuit.
      // The voltmeter input is *not* stamped here: on this range the source is what the terminals
      // present, and hanging ten megohms across it would cap the range at ten megohms.
      const g = 1 / OHMMETER_SOURCE_OHMS;
      ctx.mna.stampNorton(this.vNode, this.comNode, g, OHMMETER_SOURCE_VOLTS * g * ctx.sourceScale);
      return;
    }

    ctx.mna.stampResistance(this.vNode, this.comNode, VOLTMETER_OHMS);
  }

  commit(ctx: StampContext): void {
    this.measure(ctx, true);
  }

  private measure(ctx: StampContext, checkFuse: boolean): void {
    const across = ctx.voltage(this.vNode) - ctx.voltage(this.comNode);
    this.volts = across;
    this.ohmsVolts = across;
    this.shunt.update(ctx.voltage(this.aNode) - ctx.voltage(this.comNode), checkFuse);
  }

  /** The reading formatted for the meter's own display. */
  display(): string {
    if (this.mode === 'amps' && this.shunt.blown) return 'FUSE';
    if (this.liveCircuit) return 'LIVE';
    switch (this.mode) {
      case 'volts':
        return formatReading(this.volts, 'V');
      case 'amps':
        return formatReading(this.shunt.amps, 'A');
      case 'ohms':
        return Number.isFinite(this.resistance) ? formatReading(this.resistance, 'R') : 'OL';
    }
  }

  readout(): DeviceReadout[] {
    const rows: DeviceReadout[] = [
      { label: 'Reading', value: this.display(), alarm: this.shunt.blown || this.liveCircuit },
      { label: 'Mode', value: this.mode === 'ohms' ? 'resistance' : this.mode },
    ];

    if (this.liveCircuit) {
      rows.push({
        label: 'Why',
        value: 'something else is driving the probes -- power the circuit down to measure resistance',
        alarm: true,
      });
    }
    if (this.shunt.blown) {
      rows.push({ label: 'Fuse', value: 'blown; reset to replace', alarm: true });
    }
    if (this.mode === 'amps' && !this.shunt.blown) {
      rows.push({ label: 'Burden', value: formatReading(this.shunt.amps * RANGES[this.shunt.range].shuntOhms, 'V') });
    }
    return rows;
  }

  reset(): void {
    this.shunt.reset();
    this.volts = 0;
    this.ohmsVolts = 0;
  }
}

// ---------------------------------------------------------------------------------------------

export interface ScopeChannelOptions {
  readonly inputOhms?: number;
}

/**
 * One oscilloscope input.
 *
 * A megohm to the scope's ground terminal, which is the other half of why a scope has a ground
 * clip at all: without it the input has nothing to be a megohm *to*, and the trace is whatever the
 * node happens to float at. That is exactly what a real unclipped probe shows, so it is left to
 * behave that way rather than quietly referenced to circuit ground.
 */
export class ScopeChannel implements Device {
  readonly branchCount = 0;
  readonly internalNodeCount = 0;
  readonly nonlinear = false;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  private readonly inputOhms: number;
  private lastVolts = 0;

  constructor(
    readonly id: string,
    private readonly tip: number,
    private readonly ground: number,
    options: ScopeChannelOptions = {},
  ) {
    this.nodes = [tip, ground];
    this.inputOhms = options.inputOhms ?? 1e6;
  }

  /** Voltage at the probe tip, referenced to the scope's own ground clip. */
  get volts(): number {
    return this.lastVolts;
  }

  stamp(ctx: StampContext): void {
    if (ctx.firstIteration && ctx.timestep <= 0) this.commit(ctx);
    ctx.mna.stampResistance(this.tip, this.ground, this.inputOhms);
  }

  commit(ctx: StampContext): void {
    this.lastVolts = ctx.voltage(this.tip) - ctx.voltage(this.ground);
  }

  reset(): void {
    this.lastVolts = 0;
  }
}
