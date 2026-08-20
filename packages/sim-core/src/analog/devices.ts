/**
 * Device models.
 *
 * Every device reduces to the same two primitives once linearised: a conductance and a current
 * source. Nonlinear devices recompute both from the previous iteration's voltage; reactive devices
 * recompute both from the previous timestep's state. That uniformity is why the solver core does
 * not need to know what any of these are.
 */
import { GMIN, GROUND, type MnaSystem } from './mna.js';
import { VT } from './constants.js';

/** What a device sees while stamping itself into the system. */
export interface StampContext {
  readonly mna: MnaSystem;
  /** Node voltage from the previous Newton iteration, or previous timestep on the first. */
  voltage(node: number): number;
  /** Timestep in seconds. Zero means a DC operating-point solve, where reactances are ignored. */
  readonly timestep: number;
  /** True on the first Newton iteration at this timepoint. */
  readonly firstIteration: boolean;
  /**
   * Force Backward Euler for this step, regardless of the device's configured method.
   *
   * Set for the first step after any discontinuity -- a supply changing value, a switch flipping,
   * a GPIO pin toggling. Trapezoidal integration carries the previous step's current into the new
   * one, which is meaningless across a jump and shows up as ringing on the very edges this
   * simulator exists to get right. Backward Euler is unconditionally damped, so one step of it
   * absorbs the discontinuity before returning to second-order accuracy.
   */
  readonly forceBackwardEuler: boolean;
  /**
   * Multiplier every *independent* source must apply to its value, for the source-stepping
   * homotopy. Always 1 in normal operation. Dependent and companion sources ignore it -- scaling
   * a capacitor's companion current would corrupt its stored charge.
   */
  readonly sourceScale: number;
  /**
   * Ask for at least one more iteration.
   *
   * A limited device has deliberately not moved to where the maths pointed, so the voltage delta
   * looks small and the convergence test would wrongly declare success. Limiting must therefore
   * veto convergence explicitly.
   */
  requestIteration(): void;
}

export interface Device {
  readonly id: string;
  /** Circuit nodes this device connects to, for partitioning and connectivity. */
  readonly nodes: readonly number[];
  /** Extra branch unknowns required (voltage sources, inductors in branch form). */
  readonly branchCount: number;
  /**
   * Private nodes the device needs inside itself.
   *
   * A diode with bulk resistance is really two elements in series -- a resistor and an ideal
   * junction -- and the node between them is a genuine circuit node, not an implementation detail.
   * Trying to fold it away by combining conductances puts the full terminal voltage across the
   * junction and overstates the current by more than an order of magnitude.
   */
  readonly internalNodeCount: number;
  /** True if the device must be re-linearised each Newton iteration. */
  readonly nonlinear: boolean;
  /** Index of this device's first branch unknown, assigned by the circuit. */
  branchOffset: number;
  /** Index of this device's first internal node, assigned by the circuit. */
  internalNodeOffset: number;
  stamp(ctx: StampContext): void;
  /** Latch state after a converged solve: capacitor voltage, inductor current, and so on. */
  commit?(ctx: StampContext): void;
  /**
   * Next moment this device changes on its own, in seconds since reset, or null if it is passive
   * in time.
   *
   * The scheduler consults this so it can stop exactly at a device's own edges rather than at the
   * next interval tick. A rangefinder's echo pulse and a servo's frame boundary are as much
   * discontinuities as a GPIO write, and sampling them on a fixed clock smears the very timing the
   * sketch is measuring.
   */
  nextEventTime?(now: number): number | null;
  /** Return to the power-on state. */
  reset?(): void;
}

// ---------------------------------------------------------------------------------------------
// Linear devices
// ---------------------------------------------------------------------------------------------

export class Resistor implements Device {
  readonly branchCount = 0;
  readonly internalNodeCount = 0;
  readonly nonlinear = false;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  constructor(
    readonly id: string,
    private readonly a: number,
    private readonly b: number,
    public ohms: number,
  ) {
    if (!(ohms > 0)) throw new RangeError(`Resistor ${id}: resistance must be positive`);
    this.nodes = [a, b];
  }

  stamp(ctx: StampContext): void {
    ctx.mna.stampConductance(this.a, this.b, 1 / this.ohms);
  }

  /** Current from `a` to `b`, positive in that direction. */
  current(ctx: StampContext): number {
    return (ctx.voltage(this.a) - ctx.voltage(this.b)) / this.ohms;
  }
}

export class VoltageSource implements Device {
  readonly branchCount = 1;
  readonly internalNodeCount = 0;
  readonly nonlinear = false;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  constructor(
    readonly id: string,
    private readonly a: number,
    private readonly b: number,
    public volts: number,
  ) {
    this.nodes = [a, b];
  }

  stamp(ctx: StampContext): void {
    ctx.mna.stampVoltageSource(this.branchOffset, this.a, this.b, this.volts * ctx.sourceScale);
  }

  /** Current delivered by the supply, positive when sourcing. Negates the raw branch sign. */
  currentDelivered(mna: MnaSystem): number {
    return -mna.branchCurrent(this.branchOffset);
  }
}

export class CurrentSource implements Device {
  readonly branchCount = 0;
  readonly internalNodeCount = 0;
  readonly nonlinear = false;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  constructor(
    readonly id: string,
    private readonly a: number,
    private readonly b: number,
    public amps: number,
  ) {
    this.nodes = [a, b];
  }

  stamp(ctx: StampContext): void {
    ctx.mna.stampCurrentSource(this.a, this.b, this.amps * ctx.sourceScale);
  }
}

/**
 * An ideal-ish switch: a resistance that flips between two values.
 *
 * Modelled as a resistor rather than a true short so the matrix stays well conditioned. A closed
 * contact is milliohms, an open one is gigaohms -- both real numbers a real switch exhibits, and
 * neither creates the singularity an ideal short would.
 */
export class Switch implements Device {
  readonly branchCount = 0;
  readonly internalNodeCount = 0;
  readonly nonlinear = false;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  constructor(
    readonly id: string,
    private readonly a: number,
    private readonly b: number,
    public closed = false,
    readonly closedOhms = 0.01,
    readonly openOhms = 1e9,
  ) {
    this.nodes = [a, b];
  }

  stamp(ctx: StampContext): void {
    ctx.mna.stampConductance(this.a, this.b, 1 / (this.closed ? this.closedOhms : this.openOhms));
  }
}

// ---------------------------------------------------------------------------------------------
// Nonlinear devices
// ---------------------------------------------------------------------------------------------

export interface DiodeModel {
  /** Saturation current, amps. */
  readonly saturationCurrent: number;
  /** Emission coefficient N. ~1 for signal diodes, 2+ for LEDs. */
  readonly emissionCoefficient: number;
  /** Bulk series resistance, ohms. */
  readonly seriesResistance: number;
}

/** 1N4148-class small-signal silicon diode. */
export const DIODE_1N4148: DiodeModel = {
  saturationCurrent: 2.52e-9,
  emissionCoefficient: 1.752,
  seriesResistance: 0.568,
};

/**
 * PN junction, linearised by Newton-Raphson with SPICE's `pnjlim` damping.
 *
 * The limiting is not optional. The exponential means a first guess of 5 V across a junction
 * evaluates `exp(5 / 0.0517)` -- around 1e42 -- and the solve diverges immediately. `pnjlim` caps
 * how far the operating point may move per iteration, which converts a divergent problem into a
 * merely slow one.
 */
export class Diode implements Device {
  readonly branchCount = 0;
  readonly nonlinear = true;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];
  /** One internal node when the model has bulk resistance, splitting Rs from the junction. */
  readonly internalNodeCount: number;

  /** Last accepted junction voltage, the anchor point for limiting. */
  protected vPrev = 0;
  /** Voltage above which limiting engages, from the model parameters. */
  protected readonly vCritical: number;
  protected lastCurrent = 0;
  protected lastJunctionVoltage = 0;
  protected lastTerminalVoltage = 0;

  constructor(
    readonly id: string,
    protected readonly anode: number,
    protected readonly cathode: number,
    readonly model: DiodeModel = DIODE_1N4148,
  ) {
    this.nodes = [anode, cathode];
    this.internalNodeCount = model.seriesResistance > 0 ? 1 : 0;
    const nvt = model.emissionCoefficient * VT;
    // SPICE's critical voltage: where the exponential's curvature starts to dominate.
    this.vCritical = nvt * Math.log(nvt / (Math.SQRT2 * model.saturationCurrent));
  }

  reset(): void {
    this.vPrev = 0;
    this.lastCurrent = 0;
    this.lastJunctionVoltage = 0;
    this.lastTerminalVoltage = 0;
  }

  /** Forward current at the last converged operating point, amps. */
  get current(): number {
    return this.lastCurrent;
  }

  /**
   * Forward voltage across the whole device, volts -- junction drop plus the drop across bulk
   * resistance. This is what a multimeter across the part's legs reads, so it is the number the
   * user compares against a datasheet.
   */
  get forwardVoltage(): number {
    return this.lastTerminalVoltage;
  }

  /** Drop across the ideal junction alone, excluding bulk resistance. */
  get junctionVoltage(): number {
    return this.lastJunctionVoltage;
  }

  /** The junction's anode: the internal node when Rs is modelled, otherwise the terminal. */
  private get junctionAnode(): number {
    return this.internalNodeCount > 0 ? this.internalNodeOffset : this.anode;
  }

  stamp(ctx: StampContext): void {
    const { emissionCoefficient: n, saturationCurrent: is, seriesResistance: rs } = this.model;
    const nvt = n * VT;
    const inner = this.junctionAnode;

    // Bulk resistance is a real resistor between the terminal and the junction.
    if (this.internalNodeCount > 0) {
      ctx.mna.stampConductance(this.anode, inner, 1 / rs);
    }

    let v = ctx.voltage(inner) - ctx.voltage(this.cathode);
    if (ctx.firstIteration && this.vPrev === 0) {
      // Cold-start below the knee. Starting at 0 V makes the first Geq equal Is/nVt -- effectively
      // an open circuit -- and the solver spends many iterations just finding the junction.
      v = Math.min(v, this.vCritical);
    }

    const limited = this.limitJunction(v);
    if (limited !== v) ctx.requestIteration();
    v = limited;
    this.vPrev = v;

    // Shockley equation and its derivative at the linearisation point.
    let current: number;
    let conductance: number;
    if (v >= -5 * nvt) {
      const e = Math.exp(v / nvt);
      current = is * (e - 1);
      conductance = (is * e) / nvt;
    } else {
      // Deep reverse bias: the exponential underflows to nothing, leaving only leakage. Stamping
      // zero conductance would float the node, so keep the small-signal term alive.
      current = -is;
      conductance = is / nvt;
    }

    this.lastJunctionVoltage = v;
    this.lastCurrent = current;
    this.lastTerminalVoltage = v + current * rs;

    // Companion model: I(v) ~= Geq*v + Ieq, so Ieq is whatever the linearisation leaves over.
    ctx.mna.stampConductance(inner, this.cathode, conductance);
    ctx.mna.stampCurrentSource(inner, this.cathode, current - conductance * v);
  }

  /**
   * SPICE's `pnjlim`: bound how far the junction voltage may move in one iteration.
   *
   * Above `vCritical` the step is compressed logarithmically, so an overshoot that would otherwise
   * evaluate `exp(200)` instead lands a few thermal voltages further along the curve.
   */
  protected limitJunction(vNew: number): number {
    const nvt = this.model.emissionCoefficient * VT;
    const vOld = this.vPrev;

    if (vNew > this.vCritical && Math.abs(vNew - vOld) > 2 * nvt) {
      if (vOld > 0) {
        const arg = 1 + (vNew - vOld) / nvt;
        return arg > 0 ? vOld + nvt * Math.log(arg) : this.vCritical;
      }
      return nvt * Math.log(vNew / nvt);
    }
    return vNew;
  }
}

/** Visible-spectrum LED colours, with datasheet-typical forward voltages. */
export type LedColor = 'red' | 'yellow' | 'green' | 'blue' | 'white';

/**
 * Forward voltage at 20 mA, the number printed on every LED datasheet.
 *
 * Model parameters are derived from this point rather than hand-tuned, so an LED that reads 2.0 V
 * in simulation reads 2.0 V because a real red LED does, not because a constant was fitted.
 */
const LED_VF_AT_20MA: Record<LedColor, number> = {
  red: 2.0,
  yellow: 2.1,
  green: 3.2,
  blue: 3.3,
  white: 3.3,
};

/** LEDs have soft knees; N in this range matches measured curves far better than N=1. */
const LED_EMISSION_COEFFICIENT = 2.0;
/** Bulk resistance, which is what flattens the curve above the knee. */
const LED_SERIES_RESISTANCE = 8.0;

/** Build a diode model that passes exactly through a colour's datasheet point. */
export function ledModel(color: LedColor): DiodeModel {
  const vf = LED_VF_AT_20MA[color];
  const nvt = LED_EMISSION_COEFFICIENT * VT;
  const vJunction = vf - 0.02 * LED_SERIES_RESISTANCE;
  return {
    saturationCurrent: 0.02 / Math.exp(vJunction / nvt),
    emissionCoefficient: LED_EMISSION_COEFFICIENT,
    seriesResistance: LED_SERIES_RESISTANCE,
  };
}

/**
 * An LED: a diode that also reports how bright it looks.
 *
 * Brightness tracks actual forward current, so an under-driven LED renders dim and an LED fed
 * through too large a resistor is visibly wrong on the canvas -- which is the point.
 */
export class Led extends Diode {
  /** Current at which the LED is considered fully lit, amps. */
  readonly nominalCurrent: number;
  /** Absolute maximum forward current before damage, amps. */
  readonly maxCurrent: number;

  constructor(
    id: string,
    anode: number,
    cathode: number,
    readonly color: LedColor = 'red',
    options: { nominalCurrent?: number; maxCurrent?: number } = {},
  ) {
    super(id, anode, cathode, ledModel(color));
    this.nominalCurrent = options.nominalCurrent ?? 0.02;
    this.maxCurrent = options.maxCurrent ?? 0.03;
  }

  /**
   * Perceived brightness, 0 to 1.
   *
   * Luminous flux is roughly linear in current, but perceived brightness is not: the eye's response
   * is closer to a power law, so a square root maps current onto something that looks right.
   */
  get brightness(): number {
    if (this.current <= 0) return 0;
    return Math.min(1, Math.sqrt(this.current / this.nominalCurrent));
  }

  /** True when forward current exceeds the absolute maximum rating. */
  get overCurrent(): boolean {
    return this.current > this.maxCurrent;
  }
}

// ---------------------------------------------------------------------------------------------
// Reactive devices
// ---------------------------------------------------------------------------------------------

/**
 * Numerical integration method for reactive companion models.
 *
 * Trapezoidal is second-order accurate and the SPICE default, but it can ring on a sharp step --
 * exactly what a digital pin produces. Backward Euler is only first-order but unconditionally
 * damped, so the circuit switches to it for the first step after any discontinuity and whenever
 * trapezoidal misbehaves.
 */
export type IntegrationMethod = 'trapezoidal' | 'backward-euler';

/**
 * Capacitor, as a conductance in parallel with a current source carrying its history.
 *
 * At DC (`timestep === 0`) a capacitor is an open circuit, so it stamps nothing and lets gmin hold
 * the node. That is the correct operating-point behaviour and it is also what makes the very first
 * solve of an RC circuit start from a genuinely discharged state.
 */
export class Capacitor implements Device {
  readonly branchCount = 0;
  readonly internalNodeCount = 0;
  readonly nonlinear = false;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  /** Voltage at the end of the previous timestep. */
  private vPrev = 0;
  /** Current at the end of the previous timestep, needed by trapezoidal only. */
  private iPrev = 0;
  /** Backward Euler on the first step: there is no previous current to trapezoid against. */
  private started = false;

  constructor(
    readonly id: string,
    private readonly a: number,
    private readonly b: number,
    public farads: number,
    public method: IntegrationMethod = 'trapezoidal',
    initialVolts = 0,
  ) {
    if (!(farads > 0)) throw new RangeError(`Capacitor ${id}: capacitance must be positive`);
    this.nodes = [a, b];
    this.vPrev = initialVolts;
  }

  reset(): void {
    this.vPrev = 0;
    this.iPrev = 0;
    this.started = false;
  }

  /** Voltage across the capacitor at the last committed timestep. */
  get voltage(): number {
    return this.vPrev;
  }

  /** Current through the capacitor at the last committed timestep, positive from `a` to `b`. */
  get current(): number {
    return this.iPrev;
  }

  stamp(ctx: StampContext): void {
    // DC operating point: an ideal capacitor passes nothing.
    if (ctx.timestep <= 0) return;

    const useTrapezoidal = this.usesTrapezoidal(ctx);
    const geq = useTrapezoidal
      ? (2 * this.farads) / ctx.timestep
      : this.farads / ctx.timestep;
    const ieq = useTrapezoidal ? geq * this.vPrev + this.iPrev : geq * this.vPrev;

    ctx.mna.stampNorton(this.a, this.b, geq, ieq);
  }

  commit(ctx: StampContext): void {
    if (ctx.timestep <= 0) return;
    const v = ctx.voltage(this.a) - ctx.voltage(this.b);
    const useTrapezoidal = this.usesTrapezoidal(ctx);
    const geq = useTrapezoidal
      ? (2 * this.farads) / ctx.timestep
      : this.farads / ctx.timestep;
    const ieq = useTrapezoidal ? geq * this.vPrev + this.iPrev : geq * this.vPrev;

    this.iPrev = geq * v - ieq;
    this.vPrev = v;
    this.started = true;
  }

  /** Trapezoidal needs both a previous current and no discontinuity to integrate across. */
  private usesTrapezoidal(ctx: StampContext): boolean {
    return this.method === 'trapezoidal' && this.started && !ctx.forceBackwardEuler;
  }
}

/**
 * Inductor, the dual of the capacitor.
 *
 * At DC an ideal inductor is a short. Rather than adding a branch unknown for a zero-volt source,
 * it stamps a milliohm resistance: numerically equivalent at any current this simulator will see,
 * and it keeps the matrix the same size.
 */
export class Inductor implements Device {
  readonly branchCount = 0;
  readonly internalNodeCount = 0;
  readonly nonlinear = false;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  /** Resistance standing in for an ideal short at DC. */
  private static readonly DC_SHORT_OHMS = 1e-3;

  private iPrev = 0;
  private vPrev = 0;
  private started = false;

  constructor(
    readonly id: string,
    private readonly a: number,
    private readonly b: number,
    public henries: number,
    public method: IntegrationMethod = 'trapezoidal',
    initialAmps = 0,
  ) {
    if (!(henries > 0)) throw new RangeError(`Inductor ${id}: inductance must be positive`);
    this.nodes = [a, b];
    this.iPrev = initialAmps;
  }

  reset(): void {
    this.iPrev = 0;
    this.vPrev = 0;
    this.started = false;
  }

  /** Current through the inductor at the last committed timestep, positive from `a` to `b`. */
  get current(): number {
    return this.iPrev;
  }

  stamp(ctx: StampContext): void {
    if (ctx.timestep <= 0) {
      ctx.mna.stampConductance(this.a, this.b, 1 / Inductor.DC_SHORT_OHMS);
      return;
    }

    const useTrapezoidal = this.usesTrapezoidal(ctx);
    const geq = useTrapezoidal
      ? ctx.timestep / (2 * this.henries)
      : ctx.timestep / this.henries;
    const ieq = useTrapezoidal ? this.iPrev + geq * this.vPrev : this.iPrev;

    // Current flows from a to b, so the companion source pushes out of a and into b.
    ctx.mna.stampConductance(this.a, this.b, geq);
    ctx.mna.stampCurrentSource(this.a, this.b, ieq);
  }

  commit(ctx: StampContext): void {
    if (ctx.timestep <= 0) return;
    const v = ctx.voltage(this.a) - ctx.voltage(this.b);
    const useTrapezoidal = this.usesTrapezoidal(ctx);
    const geq = useTrapezoidal
      ? ctx.timestep / (2 * this.henries)
      : ctx.timestep / this.henries;
    const ieq = useTrapezoidal ? this.iPrev + geq * this.vPrev : this.iPrev;

    this.iPrev = geq * v + ieq;
    this.vPrev = v;
    this.started = true;
  }

  /** Trapezoidal needs both a previous current and no discontinuity to integrate across. */
  private usesTrapezoidal(ctx: StampContext): boolean {
    return this.method === 'trapezoidal' && this.started && !ctx.forceBackwardEuler;
  }
}

// ---------------------------------------------------------------------------------------------
// Transistors
// ---------------------------------------------------------------------------------------------

export type BjtPolarity = 'npn' | 'pnp';

export interface BjtModel {
  /** Transport saturation current, amps. */
  readonly saturationCurrent: number;
  /** Forward current gain, the datasheet's hFE. */
  readonly forwardBeta: number;
  /** Reverse current gain. Small, and rarely quoted, but it is what makes saturation saturate. */
  readonly reverseBeta: number;
  /** Forward emission coefficient. */
  readonly forwardEmission: number;
  /** Reverse emission coefficient. */
  readonly reverseEmission: number;
}

/** BC547B, the general-purpose NPN in every parts drawer. hFE 200-450, typical 290. */
export const BJT_BC547: BjtModel = {
  saturationCurrent: 1.8e-14,
  forwardBeta: 290,
  reverseBeta: 4,
  forwardEmission: 1,
  reverseEmission: 1,
};

/** 2N3904, the American equivalent. */
export const BJT_2N3904: BjtModel = {
  saturationCurrent: 6.7e-15,
  forwardBeta: 200,
  reverseBeta: 4,
  forwardEmission: 1,
  reverseEmission: 1,
};

/**
 * Bipolar junction transistor, Ebers-Moll in transport form.
 *
 * The first device here that amplifies, which is why the MNA layer needed a transconductance stamp
 * before it could exist: every element until now coupled a pair of nodes to itself, and a
 * transistor couples the base-emitter voltage to the collector current.
 *
 * Both junctions get `pnjlim` damping, for the same reason the diode does and more so -- a
 * transistor has two exponentials, and an undamped first guess of 5 V on either one diverges
 * immediately.
 *
 * PNP is handled by flipping the sign of every junction voltage and every terminal current, which
 * is exactly what the physics does: the same equations with holes instead of electrons.
 */
export class Bjt implements Device {
  readonly branchCount = 0;
  readonly internalNodeCount = 0;
  readonly nonlinear = true;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  /** Last accepted junction voltages, the anchors for limiting. */
  private vbePrev = 0;
  private vbcPrev = 0;
  private readonly vCriticalF: number;
  private readonly vCriticalR: number;

  private lastIc = 0;
  private lastIb = 0;
  private lastVbe = 0;
  private lastVce = 0;

  constructor(
    readonly id: string,
    private readonly collector: number,
    private readonly base: number,
    private readonly emitter: number,
    readonly polarity: BjtPolarity = 'npn',
    readonly model: BjtModel = BJT_BC547,
  ) {
    this.nodes = [collector, base, emitter];
    const nvtF = model.forwardEmission * VT;
    const nvtR = model.reverseEmission * VT;
    this.vCriticalF = nvtF * Math.log(nvtF / (Math.SQRT2 * model.saturationCurrent));
    this.vCriticalR = nvtR * Math.log(nvtR / (Math.SQRT2 * model.saturationCurrent));
  }

  reset(): void {
    this.vbePrev = 0;
    this.vbcPrev = 0;
    this.lastIc = 0;
    this.lastIb = 0;
    this.lastVbe = 0;
    this.lastVce = 0;
  }

  /** Collector current at the last converged operating point, amps. Positive into the collector. */
  get collectorCurrent(): number {
    return this.lastIc;
  }

  get baseCurrent(): number {
    return this.lastIb;
  }

  /** Base-emitter voltage. ~0.7 V when conducting, which is the number everyone checks first. */
  get vbe(): number {
    return this.lastVbe;
  }

  get vce(): number {
    return this.lastVce;
  }

  /**
   * Operating region, as a datasheet names it.
   *
   * Worth reporting because it is the question people actually have: a transistor meant to be a
   * switch that turns out to be sitting in the active region is the bug, and the numbers alone do
   * not say so.
   */
  get region(): 'cutoff' | 'active' | 'saturation' | 'reverse' {
    const on = (v: number) => v > 0.4;
    const beOn = on(this.polarity === 'npn' ? this.lastVbe : -this.lastVbe);
    const bcOn = on(
      this.polarity === 'npn'
        ? this.lastVbe - this.lastVce
        : -(this.lastVbe - this.lastVce),
    );
    if (!beOn && !bcOn) return 'cutoff';
    if (beOn && !bcOn) return 'active';
    if (beOn && bcOn) return 'saturation';
    return 'reverse';
  }

  stamp(ctx: StampContext): void {
    const {
      saturationCurrent: is,
      forwardBeta: bf,
      reverseBeta: br,
      forwardEmission: nf,
      reverseEmission: nr,
    } = this.model;

    const nvtF = nf * VT;
    const nvtR = nr * VT;
    // PNP is the same device with every voltage inverted.
    const sign = this.polarity === 'npn' ? 1 : -1;

    let vbe = sign * (ctx.voltage(this.base) - ctx.voltage(this.emitter));
    let vbc = sign * (ctx.voltage(this.base) - ctx.voltage(this.collector));

    if (ctx.firstIteration && this.vbePrev === 0 && this.vbcPrev === 0) {
      // Cold start below the knee on both junctions, or the first Geq is an open circuit and the
      // solver spends many iterations finding the device at all.
      vbe = Math.min(vbe, this.vCriticalF);
      vbc = Math.min(vbc, this.vCriticalR);
    }

    const limitedBe = limitJunction(vbe, this.vbePrev, nvtF, this.vCriticalF);
    const limitedBc = limitJunction(vbc, this.vbcPrev, nvtR, this.vCriticalR);
    if (limitedBe !== vbe || limitedBc !== vbc) ctx.requestIteration();
    vbe = limitedBe;
    vbc = limitedBc;
    this.vbePrev = vbe;
    this.vbcPrev = vbc;

    // Exponentials, floored in deep reverse bias where they underflow to nothing.
    const expBe = vbe >= -5 * nvtF ? Math.exp(vbe / nvtF) : 0;
    const expBc = vbc >= -5 * nvtR ? Math.exp(vbc / nvtR) : 0;

    // Transport current, and the two base recombination currents.
    const ict = is * (expBe - expBc);
    const ibe = (is / bf) * (expBe - 1);
    const ibc = (is / br) * (expBc - 1);

    // Small-signal conductances. Floored at gmin so a cut-off device still ties its nodes into
    // the matrix rather than floating them.
    const gf = Math.max((is / nvtF) * expBe, GMIN);
    const gr = Math.max((is / nvtR) * expBc, GMIN);
    const gpi = Math.max(gf / bf, GMIN);
    const gmu = Math.max(gr / br, GMIN);

    const b = this.base;
    const c = this.collector;
    const e = this.emitter;

    // Base-emitter and base-collector junctions, as conductances with their linearisation offsets.
    ctx.mna.stampConductance(b, e, gpi);
    ctx.mna.stampCurrentSource(b, e, sign * (ibe - gpi * vbe));

    ctx.mna.stampConductance(b, c, gmu);
    ctx.mna.stampCurrentSource(b, c, sign * (ibc - gmu * vbc));

    // Transport: the forward term is what makes it an amplifier, the reverse term is what makes
    // saturation behave.
    ctx.mna.stampVCCS(c, e, b, e, gf);
    ctx.mna.stampVCCS(e, c, b, c, gr);
    ctx.mna.stampCurrentSource(c, e, sign * (ict - gf * vbe + gr * vbc));

    this.lastVbe = sign * vbe;
    this.lastVce = sign * (vbe - vbc);
    this.lastIc = sign * (ict - ibc);
    this.lastIb = sign * (ibe + ibc);
  }
}

/**
 * SPICE's `pnjlim`, shared by every device with a PN junction.
 *
 * Extracted from the diode once the transistor needed it twice over: a BJT has two junctions, and
 * an undamped first guess on either diverges on the first iteration.
 */
function limitJunction(vNew: number, vOld: number, nvt: number, vCritical: number): number {
  if (vNew > vCritical && Math.abs(vNew - vOld) > 2 * nvt) {
    if (vOld > 0) {
      const arg = 1 + (vNew - vOld) / nvt;
      return arg > 0 ? vOld + nvt * Math.log(arg) : vCritical;
    }
    return nvt * Math.log(vNew / nvt);
  }
  return vNew;
}

// ---------------------------------------------------------------------------------------------
// MOSFETs
// ---------------------------------------------------------------------------------------------

export type MosfetChannel = 'n' | 'p';

export interface MosfetModel {
  /** Gate threshold voltage, the datasheet's VGS(th). */
  readonly threshold: number;
  /**
   * Transconductance parameter, amps per volt squared.
   *
   * Datasheets give a drain current at a stated VGS rather than this directly. Derive it from that
   * point: `K = 2 * Id / (Vgs - Vth)^2`.
   */
  readonly k: number;
  /** Channel-length modulation. Small; it is what gives a saturated device finite output impedance. */
  readonly lambda: number;
  /** On-resistance floor, the datasheet's RDS(on). Level 1 alone predicts an unrealistically low one. */
  readonly rdsOn: number;
  /** Body diode, which every power MOSFET has whether or not the circuit wants it. */
  readonly bodyDiode: DiodeModel;
}

/**
 * IRLZ44N-class logic-level N-channel MOSFET.
 *
 * The part people reach for to switch a motor or an LED strip from a 5 V pin, because it turns on
 * properly at gate voltages an Arduino can actually produce.
 */
export const MOSFET_IRLZ44N: MosfetModel = {
  threshold: 1.8,
  k: 20,
  lambda: 0.02,
  rdsOn: 0.022,
  bodyDiode: { saturationCurrent: 1e-12, emissionCoefficient: 1.5, seriesResistance: 0.01 },
};

/**
 * 2N7000-class small-signal N-channel MOSFET.
 *
 * Not logic-level: its threshold is high enough that a 5 V gate barely turns it on, which is
 * exactly the mistake this simulator should be able to show you.
 */
export const MOSFET_2N7000: MosfetModel = {
  threshold: 2.1,
  k: 0.5,
  lambda: 0.02,
  rdsOn: 1.2,
  bodyDiode: { saturationCurrent: 1e-13, emissionCoefficient: 1.6, seriesResistance: 0.5 },
};

/**
 * MOSFET, level 1 (Shichman-Hodges).
 *
 * Enough to answer the questions people actually have about a switching stage: does the gate
 * voltage available turn it fully on, how much does it drop while conducting, and how much does it
 * dissipate. Not enough for RF or precision analog work, which would want level 3 or BSIM -- said
 * here so nobody assumes otherwise.
 *
 * The body diode is not optional. It is physically part of the device, and it is what conducts the
 * back-EMF when a motor or relay coil is switched off -- so a simulation without it would show a
 * flyback spike that the real part would have clamped.
 */
export class Mosfet implements Device {
  readonly branchCount = 0;
  readonly nonlinear = true;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];
  /** One internal node for the body diode's bulk resistance. */
  readonly internalNodeCount = 1;

  private vgsPrev = 0;
  private vdsPrev = 0;
  private lastId = 0;
  private lastVgs = 0;
  private lastVds = 0;

  /** Body diode state, limited independently of the channel. */
  private vBodyPrev = 0;
  private readonly vBodyCritical: number;
  private lastBodyCurrent = 0;

  constructor(
    readonly id: string,
    private readonly drain: number,
    private readonly gate: number,
    private readonly source: number,
    readonly channel: MosfetChannel = 'n',
    readonly model: MosfetModel = MOSFET_IRLZ44N,
  ) {
    this.nodes = [drain, gate, source];
    const nvt = model.bodyDiode.emissionCoefficient * VT;
    this.vBodyCritical = nvt * Math.log(nvt / (Math.SQRT2 * model.bodyDiode.saturationCurrent));
  }

  reset(): void {
    this.vgsPrev = 0;
    this.vdsPrev = 0;
    this.lastId = 0;
    this.lastVgs = 0;
    this.lastVds = 0;
    this.vBodyPrev = 0;
    this.lastBodyCurrent = 0;
  }

  /**
   * Current through the body diode, amps.
   *
   * Non-zero means the device is being driven backwards -- which for a motor or relay coil is the
   * flyback the diode is there to clamp, and for an H-bridge is usually a shoot-through bug.
   */
  get bodyDiodeCurrent(): number {
    return this.lastBodyCurrent;
  }

  /** Drain current at the last converged point, amps. Positive into the drain for an N-channel. */
  get drainCurrent(): number {
    return this.lastId;
  }

  get vgs(): number {
    return this.lastVgs;
  }

  get vds(): number {
    return this.lastVds;
  }

  /** Power dissipated in the channel, watts. What decides whether it needs a heatsink. */
  get dissipation(): number {
    return Math.abs(this.lastId * this.lastVds);
  }

  /**
   * Operating region.
   *
   * `linear` is what a switch wants -- fully on, dropping almost nothing. A device meant as a
   * switch that reports `saturation` is being run as an amplifier, dissipating heat, which is the
   * classic symptom of a gate that is not being driven hard enough.
   */
  get region(): 'cutoff' | 'linear' | 'saturation' {
    const sign = this.channel === 'n' ? 1 : -1;
    const overdrive = sign * this.lastVgs - this.model.threshold;
    if (overdrive <= 0) return 'cutoff';
    return sign * this.lastVds < overdrive ? 'linear' : 'saturation';
  }

  stamp(ctx: StampContext): void {
    const { threshold: vth, k, lambda, rdsOn } = this.model;
    // A P-channel is the same device with every voltage inverted.
    const sign = this.channel === 'n' ? 1 : -1;

    let vgs = sign * (ctx.voltage(this.gate) - ctx.voltage(this.source));
    let vds = sign * (ctx.voltage(this.drain) - ctx.voltage(this.source));

    // Bound how far the operating point may move per iteration. Level 1 is quadratic rather than
    // exponential, so it needs less damping than a junction -- but an unbounded first guess on a
    // power device still overshoots by amps.
    const limit = 0.5;
    if (Math.abs(vgs - this.vgsPrev) > limit) {
      vgs = this.vgsPrev + Math.sign(vgs - this.vgsPrev) * limit;
      ctx.requestIteration();
    }
    if (Math.abs(vds - this.vdsPrev) > limit) {
      vds = this.vdsPrev + Math.sign(vds - this.vdsPrev) * limit;
      ctx.requestIteration();
    }
    this.vgsPrev = vgs;
    this.vdsPrev = vds;

    const overdrive = vgs - vth;
    let id = 0;
    let gm = 0;
    let gds = GMIN;

    if (overdrive > 0) {
      // Reverse conduction: a MOSFET channel is symmetric, so negative Vds simply flows the other
      // way. Solving with |Vds| and restoring the sign keeps the model valid in both directions,
      // which matters in an H-bridge.
      const reverse = vds < 0;
      const vdsMag = Math.abs(vds);
      const modulation = 1 + lambda * vdsMag;

      if (vdsMag < overdrive) {
        // Triode: what a switch that is properly on looks like.
        id = k * (overdrive * vdsMag - (vdsMag * vdsMag) / 2) * modulation;
        gm = k * vdsMag * modulation;
        gds = k * (overdrive - vdsMag) * modulation + k * (overdrive * vdsMag - (vdsMag * vdsMag) / 2) * lambda;
      } else {
        // Saturation: acting as a current source, and dissipating.
        id = (k / 2) * overdrive * overdrive * modulation;
        gm = k * overdrive * modulation;
        gds = (k / 2) * overdrive * overdrive * lambda;
      }

      // Level 1 predicts an on-resistance far below what a real device achieves, so the datasheet's
      // RDS(on) is imposed as a floor. Without it a simulated switch drops millivolts where the
      // real one drops tenths of a volt, and the dissipation figure is meaningless.
      const maxConductance = 1 / rdsOn;
      if (gds > maxConductance) {
        gds = maxConductance;
        id = Math.min(id, vdsMag * maxConductance);
      }

      if (reverse) {
        id = -id;
        gm = -gm;
      }
      gds = Math.max(gds, GMIN);
    }

    const d = this.drain;
    const g = this.gate;
    const s = this.source;

    // Channel: a transconductance from the gate plus the output conductance.
    ctx.mna.stampVCCS(d, s, g, s, sign > 0 ? gm : -gm);
    ctx.mna.stampConductance(d, s, gds);
    ctx.mna.stampCurrentSource(d, s, sign * (id - gm * vgs - gds * vds));

    // The gate is insulated. A large leak keeps it in the matrix rather than floating, which is
    // also physically honest -- real gates leak nanoamps.
    ctx.mna.stampConductance(g, s, GMIN);

    this.stampBodyDiode(ctx, sign);

    this.lastVgs = sign * vgs;
    this.lastVds = sign * vds;
    this.lastId = sign * id;
  }

  /**
   * The intrinsic body diode, from source to drain on an N-channel.
   *
   * Every power MOSFET has one whether the circuit wants it or not, and it is what conducts when
   * an inductive load is switched off. A simulation without it would show a flyback spike the real
   * part would have clamped -- and would then not warn about the one case where it matters, an
   * unclamped coil driven by a device that has no body diode at all.
   */
  private stampBodyDiode(ctx: StampContext, sign: number): void {
    const model = this.model.bodyDiode;
    const nvt = model.emissionCoefficient * VT;

    // Anode and cathode, with the internal node carrying the diode's bulk resistance.
    const anode = sign > 0 ? this.source : this.drain;
    const cathode = sign > 0 ? this.drain : this.source;
    const inner = this.internalNodeOffset;

    ctx.mna.stampConductance(anode, inner, 1 / Math.max(model.seriesResistance, 1e-6));

    let v = ctx.voltage(inner) - ctx.voltage(cathode);
    if (ctx.firstIteration && this.vBodyPrev === 0) v = Math.min(v, this.vBodyCritical);

    const limited = limitJunction(v, this.vBodyPrev, nvt, this.vBodyCritical);
    if (limited !== v) ctx.requestIteration();
    v = limited;
    this.vBodyPrev = v;

    let current: number;
    let conductance: number;
    if (v >= -5 * nvt) {
      const e = Math.exp(v / nvt);
      current = model.saturationCurrent * (e - 1);
      conductance = (model.saturationCurrent * e) / nvt;
    } else {
      current = -model.saturationCurrent;
      conductance = model.saturationCurrent / nvt;
    }

    ctx.mna.stampConductance(inner, cathode, conductance);
    ctx.mna.stampCurrentSource(inner, cathode, current - conductance * v);
    this.lastBodyCurrent = current;
  }
}

// ---------------------------------------------------------------------------------------------
// Op-amps
// ---------------------------------------------------------------------------------------------

export interface OpAmpModel {
  /** Open-loop DC gain. 100 dB is 100,000, typical of a general-purpose part. */
  readonly openLoopGain: number;
  /** Output impedance, ohms. */
  readonly outputImpedance: number;
  /** Differential input impedance, ohms. */
  readonly inputImpedance: number;
  /**
   * How close the output can get to each rail.
   *
   * The single most consequential number in practice. A classic LM358 cannot reach within about
   * 1.5 V of its positive rail, which is why so many single-supply circuits built with one behave
   * nothing like the textbook says. A rail-to-rail part gets within millivolts.
   */
  readonly headroomHigh: number;
  readonly headroomLow: number;
}

/** LM358-class general purpose op-amp. Cannot swing near its positive rail. */
export const OPAMP_LM358: OpAmpModel = {
  openLoopGain: 100_000,
  outputImpedance: 100,
  inputImpedance: 1e9,
  headroomHigh: 1.5,
  headroomLow: 0.02,
};

/** MCP6002-class rail-to-rail op-amp, which does what a beginner expects an op-amp to do. */
export const OPAMP_RAIL_TO_RAIL: OpAmpModel = {
  openLoopGain: 112_000,
  outputImpedance: 60,
  inputImpedance: 1e12,
  headroomHigh: 0.025,
  headroomLow: 0.025,
};

/**
 * Operational amplifier.
 *
 * Modelled as a saturating voltage-controlled voltage source behind an output impedance. The
 * saturation is the point: an ideal linear op-amp would happily output forty volts from a five
 * volt supply and every comparator circuit would appear to work perfectly, including the ones that
 * do not.
 *
 * The transfer curve is `tanh`-shaped rather than a hard clamp, so it is differentiable everywhere
 * -- Newton needs a derivative, and a hard corner at the rail makes the solver oscillate across it
 * instead of settling.
 */
export class OpAmp implements Device {
  readonly branchCount = 1;
  readonly internalNodeCount = 1;
  readonly nonlinear = true;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  private lastOutput = 0;
  private lastDifferential = 0;
  /** How far into the transfer curve's flat region the amplifier is, 0 to 1. */
  private lastSaturation = 0;

  constructor(
    readonly id: string,
    private readonly nonInverting: number,
    private readonly inverting: number,
    private readonly output: number,
    /** Supply rails. The output cannot go outside them, which is the whole point. */
    private readonly positiveRail: number,
    private readonly negativeRail: number,
    readonly model: OpAmpModel = OPAMP_LM358,
  ) {
    this.nodes = [nonInverting, inverting, output, positiveRail, negativeRail];
  }

  reset(): void {
    this.lastOutput = 0;
    this.lastDifferential = 0;
    this.lastSaturation = 0;
  }

  /** Output voltage at the last converged point. */
  get outputVoltage(): number {
    return this.lastOutput;
  }

  /** Differential input voltage. Near zero in a working feedback loop -- the "virtual short". */
  get differentialInput(): number {
    return this.lastDifferential;
  }

  /**
   * True when the amplifier has run out of swing and the feedback loop is no longer in control.
   *
   * Measured from the transfer curve rather than by comparing the output pin against the rail.
   * The pin sits behind an output impedance, so any load drops it a little below what the
   * amplifier is actually producing -- and a saturated amplifier driving a load would otherwise
   * report itself as fine.
   */
  get saturated(): boolean {
    return this.lastSaturation > 0.99;
  }

  private railHigh = 0;
  private railLow = 0;

  stamp(ctx: StampContext): void {
    const { openLoopGain, outputImpedance, inputImpedance } = this.model;

    // Inputs draw almost nothing, but must still be tied into the matrix.
    ctx.mna.stampConductance(this.nonInverting, this.inverting, 1 / inputImpedance);
    ctx.mna.stampConductance(this.nonInverting, GROUND, GMIN);
    ctx.mna.stampConductance(this.inverting, GROUND, GMIN);

    this.railHigh = ctx.voltage(this.positiveRail);
    this.railLow = ctx.voltage(this.negativeRail);

    const high = this.railHigh - this.model.headroomHigh;
    const low = this.railLow + this.model.headroomLow;
    const mid = (high + low) / 2;
    const span = Math.max(high - low, 1e-6);

    const differential = ctx.voltage(this.nonInverting) - ctx.voltage(this.inverting);

    // A tanh transfer curve: linear with slope `openLoopGain` near zero, flattening smoothly into
    // each rail. Differentiable everywhere, which a hard clamp is not.
    const x = (2 * openLoopGain * differential) / span;
    const tanh = Math.tanh(Math.max(-30, Math.min(30, x)));
    const target = mid + (span / 2) * tanh;
    // d(target)/d(differential), which collapses toward zero once saturated -- exactly the loss of
    // loop gain that makes a saturated amplifier stop responding.
    const gain = openLoopGain * (1 - tanh * tanh);

    // The controlled source drives an internal node; the output impedance sits between that and
    // the pin, so a loaded output sags the way a real one does.
    const inner = this.internalNodeOffset;
    ctx.mna.stampVCVS(this.branchOffset, inner, GROUND, this.nonInverting, this.inverting, gain);
    // The VCVS supplies only the gain term; the constant part of the linearisation about the
    // current operating point goes on the same constraint row.
    ctx.mna.stampVoltageSourceOffset(this.branchOffset, target - gain * differential);

    ctx.mna.stampConductance(inner, this.output, 1 / outputImpedance);

    this.lastDifferential = differential;
    this.lastOutput = ctx.voltage(this.output);
    this.lastSaturation = Math.abs(tanh);
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Three-terminal potentiometer.
 *
 * Not the same thing as a variable resistor, and the difference is what most beginner circuits
 * depend on: a pot wired across a supply is a divider whose wiper sits at a fraction of it,
 * independent of the track's total resistance. Wiring only two terminals gives a rheostat instead,
 * whose behaviour depends entirely on what else is in the circuit.
 */
export class Potentiometer implements Device {
  readonly branchCount = 0;
  readonly internalNodeCount = 0;
  readonly nonlinear = false;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  /**
   * Smallest resistance either half may present.
   *
   * A wiper at an extreme would otherwise be a dead short, which is both numerically awkward and
   * physically wrong: a real track has end resistance.
   */
  private static readonly MIN_SEGMENT_OHMS = 0.5;

  constructor(
    readonly id: string,
    private readonly terminalA: number,
    private readonly wiper: number,
    private readonly terminalB: number,
    public totalOhms = 10_000,
    /** Wiper position, 0 at terminal A and 1 at terminal B. */
    public position = 0.5,
    /** Logarithmic ("audio") taper, as volume controls use. */
    public taper: 'linear' | 'log' = 'linear',
  ) {
    if (!(totalOhms > 0)) throw new RangeError(`Potentiometer ${id}: resistance must be positive`);
    this.nodes = [terminalA, wiper, terminalB];
  }

  /** Effective position after the taper. */
  get effectivePosition(): number {
    const clamped = Math.min(1, Math.max(0, this.position));
    // An audio taper approximates a logarithmic law; this is the standard cheap approximation.
    return this.taper === 'log' ? clamped * clamped : clamped;
  }

  /** Resistance from terminal A to the wiper. */
  get resistanceA(): number {
    return Math.max(Potentiometer.MIN_SEGMENT_OHMS, this.totalOhms * this.effectivePosition);
  }

  /** Resistance from the wiper to terminal B. */
  get resistanceB(): number {
    return Math.max(Potentiometer.MIN_SEGMENT_OHMS, this.totalOhms * (1 - this.effectivePosition));
  }

  stamp(ctx: StampContext): void {
    ctx.mna.stampConductance(this.terminalA, this.wiper, 1 / this.resistanceA);
    ctx.mna.stampConductance(this.wiper, this.terminalB, 1 / this.resistanceB);
  }
}
