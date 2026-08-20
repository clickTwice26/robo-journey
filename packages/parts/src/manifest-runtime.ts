/**
 * Manifest runtime: turning a described component into a simulated one.
 *
 * Every pin model maps onto primitives the solver already speaks, and every behaviour is a small
 * state machine that reads pin voltages after each solve and decides what to stamp next. Nothing
 * here can express something the engine cannot simulate, which is deliberate -- a manifest that
 * described impossible physics would fail at run time instead of at load time.
 */
import {
  GROUND,
  Led,
  type Device,
  type StampContext,
} from '@robo-journey/sim-core';
import type {
  Behavior,
  ComponentManifest,
  ManifestPin,
  StateVariable,
} from './manifest.js';
import type { PartDefinition, PartPin } from './registry.js';

/** Logic thresholds default to fractions of the supply when a datasheet gives none. */
const DEFAULT_VIH_FACTOR = 0.7;
const DEFAULT_VIL_FACTOR = 0.3;
/** Stand-in for a pull resistor whose value the datasheet omitted. */
const DEFAULT_PULL_OHMS = 10_000;
/** A pin that is not connected still has to be something; make it effectively nothing. */
const UNCONNECTED_OHMS = 1e9;

/**
 * Live, user-adjustable inputs to a component.
 *
 * A rangefinder with nothing to range is a rangefinder that reports nothing, so every state
 * variable becomes a control in the UI and a value here.
 */
export class ComponentState {
  private readonly values = new Map<string, number>();

  constructor(variables: readonly StateVariable[]) {
    for (const variable of variables) this.values.set(variable.name, variable.default);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  set(name: string, value: number): void {
    this.values.set(name, value);
  }

  entries(): [string, number][] {
    return [...this.values.entries()];
  }
}

export interface ManifestDeviceContext {
  readonly manifest: ComponentManifest;
  readonly state: ComponentState;
  /** Circuit node for each of the component's pins, by pin name. */
  readonly nodes: ReadonlyMap<string, number>;
  /** Supply voltage the board runs at, for threshold and clamping maths. */
  readonly supplyVolts: number;
}

/**
 * One device implementing a whole manifest.
 *
 * Kept as a single device rather than one per pin because behaviour couples pins -- an echo pulse
 * depends on a trigger seen on another pin -- and splitting that across devices would mean sharing
 * mutable state between them anyway.
 */
export class ManifestDevice implements Device {
  readonly branchCount = 0;
  readonly internalNodeCount = 0;
  readonly nonlinear = false;
  branchOffset = 0;
  internalNodeOffset = -1;
  readonly nodes: readonly number[];

  private readonly manifest: ComponentManifest;
  private readonly state: ComponentState;
  private readonly nodeOf: ReadonlyMap<string, number>;
  private readonly supplyVolts: number;

  /** Digital outputs the behaviour is currently driving: pin name to level. */
  private readonly driven = new Map<string, boolean>();
  /** Analog outputs the behaviour is currently sourcing: pin name to volts. */
  private readonly sourced = new Map<string, number>();

  // --- Behaviour state -------------------------------------------------------------------------
  /** pulse-echo: when the echo pulse starts and ends, or null when idle. */
  private echoWindow: { start: number; end: number } | null = null;
  private triggerHighSince: number | null = null;
  private lastTriggerLevel = false;
  /** pwm-actuator: measured pulse and the position it commands. */
  private pulseStart: number | null = null;
  private lastSignalLevel = false;
  private commandedPosition: number | null = null;
  private actualPosition: number;
  private lastCommitTime = 0;
  /** threshold-switch: held across the hysteresis band. */
  private switchOn = false;

  constructor(
    readonly id: string,
    context: ManifestDeviceContext,
  ) {
    this.manifest = context.manifest;
    this.state = context.state;
    this.nodeOf = context.nodes;
    this.supplyVolts = context.supplyVolts;
    this.nodes = [...context.nodes.values()];

    const behavior = this.manifest.behavior;
    this.actualPosition = behavior.kind === 'pwm-actuator' ? behavior.minPosition : 0;
  }

  /** Position of a `pwm-actuator`, in the part's own units. Null before any pulse arrives. */
  get position(): number | null {
    return this.manifest.behavior.kind === 'pwm-actuator' ? this.actualPosition : null;
  }

  /** Current drawn by the behaviour, amps. Servos moving is what browns out a board. */
  get behaviorCurrent(): number {
    const behavior = this.manifest.behavior;
    if (behavior.kind !== 'pwm-actuator') return 0;
    const moving = this.commandedPosition !== null &&
      Math.abs(this.commandedPosition - this.actualPosition) > 0.5;
    return moving ? behavior.movingCurrentA : behavior.holdCurrentA;
  }

  reset(): void {
    this.driven.clear();
    this.sourced.clear();
    this.echoWindow = null;
    this.triggerHighSince = null;
    this.lastTriggerLevel = false;
    this.pulseStart = null;
    this.lastSignalLevel = false;
    this.commandedPosition = null;
    this.lastCommitTime = 0;
    this.switchOn = false;
    const behavior = this.manifest.behavior;
    this.actualPosition = behavior.kind === 'pwm-actuator' ? behavior.minPosition : 0;
  }

  private node(name: string): number {
    return this.nodeOf.get(name) ?? GROUND;
  }

  // ---------------------------------------------------------------------------------------------

  stamp(ctx: StampContext): void {
    for (const pin of this.manifest.pins) this.stampPin(ctx, pin);
    this.stampBehavior(ctx);
  }

  private stampPin(ctx: StampContext, pin: ManifestPin): void {
    const node = this.node(pin.name);
    const model = pin.model;

    switch (model.kind) {
      case 'power':
        // A supply pin loads the rail by its quiescent draw. Modelled as a current sink so it
        // shows up in the board's total and can brown out a weak supply.
        if (model.iQuiescent > 0) ctx.mna.stampCurrentSource(node, GROUND, model.iQuiescent);
        break;

      case 'ground':
        // Ground pins are connected by the user's wiring, not by the part.
        break;

      case 'digital-in': {
        ctx.mna.stampConductance(node, GROUND, 1 / model.impedanceOhms);
        if (model.pull === 'down') {
          ctx.mna.stampConductance(node, GROUND, 1 / (model.pullOhms ?? DEFAULT_PULL_OHMS));
        }
        // A pull-up needs the part's own supply node, which the user wired; approximate it with a
        // Thevenin source at the nominal supply so an unconnected input still reads high.
        if (model.pull === 'up') {
          const ohms = model.pullOhms ?? DEFAULT_PULL_OHMS;
          ctx.mna.stampNorton(node, GROUND, 1 / ohms, this.supplyVolts / ohms);
        }
        break;
      }

      case 'digital-out': {
        const level = this.driven.get(pin.name);
        if (level === undefined) {
          // Not driving: high impedance, as a real output is before it is enabled.
          ctx.mna.stampConductance(node, GROUND, 1 / UNCONNECTED_OHMS);
          break;
        }
        const g = 1 / model.impedanceOhms;
        if (level) {
          if (model.openDrain) {
            // Open-drain high is simply released, not driven.
            ctx.mna.stampConductance(node, GROUND, 1 / UNCONNECTED_OHMS);
          } else {
            ctx.mna.stampNorton(node, GROUND, g, this.supplyVolts * g);
          }
        } else {
          ctx.mna.stampConductance(node, GROUND, g);
        }
        break;
      }

      case 'analog-in':
        ctx.mna.stampConductance(node, GROUND, 1 / model.impedanceOhms);
        break;

      case 'analog-out': {
        const volts = this.sourced.get(pin.name);
        const g = 1 / model.impedanceOhms;
        if (volts === undefined) {
          ctx.mna.stampConductance(node, GROUND, 1 / UNCONNECTED_OHMS);
        } else {
          ctx.mna.stampNorton(node, GROUND, g, volts * g);
        }
        break;
      }

      case 'passive': {
        const other = this.node(model.toPin);
        if (model.ohms !== undefined) ctx.mna.stampConductance(node, other, 1 / model.ohms);
        // Capacitance is stamped by the behaviour layer only when a timestep exists; at DC an
        // ideal capacitor passes nothing, which is the correct operating point.
        break;
      }

      case 'led':
      case 'nc':
        // LEDs are added as real Led devices at build time so they get proper Newton treatment;
        // NC pins are left floating on purpose.
        break;
    }
  }

  private stampBehavior(ctx: StampContext): void {
    const behavior = this.manifest.behavior;

    if (behavior.kind === 'variable-resistor') {
      ctx.mna.stampConductance(
        this.node(behavior.pinA),
        this.node(behavior.pinB),
        1 / this.currentResistance(behavior),
      );
    }

    if (behavior.kind === 'pwm-actuator') {
      // The load a servo puts on the supply. Modelled on the signal pin's reference because the
      // manifest does not say which supply pin feeds the motor; the magnitude is what matters for
      // brownout detection.
      const power = this.manifest.pins.find((p) => p.model.kind === 'power');
      if (power) ctx.mna.stampCurrentSource(this.node(power.name), GROUND, this.behaviorCurrent);
    }
  }

  /** Logarithmic interpolation, which is how photoresistors and thermistors actually behave. */
  private currentResistance(behavior: Extract<Behavior, { kind: 'variable-resistor' }>): number {
    const variable = this.manifest.state.find((s) => s.name === behavior.state);
    if (!variable) return behavior.ohmsAtMin;

    const value = this.state.get(behavior.state);
    const span = variable.max - variable.min;
    const t = span === 0 ? 0 : Math.min(1, Math.max(0, (value - variable.min) / span));
    return Math.exp(
      Math.log(behavior.ohmsAtMin) + t * (Math.log(behavior.ohmsAtMax) - Math.log(behavior.ohmsAtMin)),
    );
  }

  // ---------------------------------------------------------------------------------------------

  commit(ctx: StampContext): void {
    const now = this.timeOf(ctx);
    this.updateBehavior(ctx, now);
    this.lastCommitTime = now;
  }

  /**
   * The device has no clock of its own, so simulated time is accumulated from the timesteps it is
   * handed. Good enough for edge timing, which is all any of these behaviours measure.
   */
  private timeOf(ctx: StampContext): number {
    return this.lastCommitTime + Math.max(0, ctx.timestep);
  }

  private updateBehavior(ctx: StampContext, now: number): void {
    const behavior = this.manifest.behavior;

    switch (behavior.kind) {
      case 'analog-sensor': {
        let volts = this.state.get(behavior.state) * behavior.voltsPerUnit + behavior.offsetVolts;
        // Clamped to the rails, because a real part cannot output more than it is fed -- which is
        // why a TMP36 reading stops making sense above about 125 C on a 3.3 V supply.
        if (behavior.clampToSupply) volts = Math.min(this.supplyVolts, Math.max(0, volts));
        this.sourced.set(behavior.outputPin, volts);
        break;
      }

      case 'threshold-switch': {
        const value = this.state.get(behavior.state);
        // Hysteresis, so a value sitting on the threshold does not chatter every solve.
        if (!this.switchOn && value > behavior.threshold + behavior.hysteresis) this.switchOn = true;
        else if (this.switchOn && value < behavior.threshold - behavior.hysteresis) this.switchOn = false;

        this.driven.set(behavior.outputPin, behavior.activeLow ? !this.switchOn : this.switchOn);
        break;
      }

      case 'pulse-echo': {
        const level = this.readLogic(ctx, behavior.triggerPin);

        if (level && !this.lastTriggerLevel) this.triggerHighSince = now;
        if (!level && this.lastTriggerLevel && this.triggerHighSince !== null) {
          const width = now - this.triggerHighSince;
          if (width >= behavior.minTriggerSeconds && this.echoWindow === null) {
            // A valid trigger schedules the echo. Its width encodes the measurement, which is the
            // entire protocol these modules use.
            const distance = this.state.get(behavior.state);
            const echoWidth = Math.min(
              distance * behavior.secondsPerUnit,
              behavior.timeoutSeconds,
            );
            const start = now + behavior.responseDelaySeconds;
            this.echoWindow = { start, end: start + echoWidth };
          }
          this.triggerHighSince = null;
        }
        this.lastTriggerLevel = level;

        if (this.echoWindow) {
          if (now >= this.echoWindow.end) {
            this.driven.set(behavior.echoPin, false);
            this.echoWindow = null;
          } else {
            this.driven.set(behavior.echoPin, now >= this.echoWindow.start);
          }
        } else {
          this.driven.set(behavior.echoPin, false);
        }
        break;
      }

      case 'pwm-actuator': {
        const level = this.readLogic(ctx, behavior.signalPin);

        if (level && !this.lastSignalLevel) this.pulseStart = now;
        if (!level && this.lastSignalLevel && this.pulseStart !== null) {
          const width = now - this.pulseStart;
          // Ignore anything outside the servo's accepted window, as a real one does.
          if (width >= behavior.minPulseSeconds * 0.5 && width <= behavior.maxPulseSeconds * 1.5) {
            const t =
              (width - behavior.minPulseSeconds) /
              (behavior.maxPulseSeconds - behavior.minPulseSeconds);
            this.commandedPosition =
              behavior.minPosition +
              Math.min(1, Math.max(0, t)) * (behavior.maxPosition - behavior.minPosition);
          }
          this.pulseStart = null;
        }
        this.lastSignalLevel = level;

        // Position lags the command at the servo's slew rate. A servo that snapped instantly would
        // hide exactly the timing problems people build simulations to find.
        if (this.commandedPosition !== null) {
          const dt = Math.max(0, ctx.timestep);
          const maxStep = behavior.slewPerSecond * dt;
          const delta = this.commandedPosition - this.actualPosition;
          this.actualPosition += Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
        }
        break;
      }

      default:
        break;
    }
  }

  /** Read a pin as logic, using the datasheet's own thresholds where the manifest gives them. */
  private readLogic(ctx: StampContext, pinName: string): boolean {
    const voltage = ctx.voltage(this.node(pinName));
    const pin = this.manifest.pins.find((p) => p.name === pinName);
    if (pin?.model.kind === 'digital-in') {
      return voltage >= (pin.model.vih + pin.model.vil) / 2;
    }
    return voltage >= this.supplyVolts * ((DEFAULT_VIH_FACTOR + DEFAULT_VIL_FACTOR) / 2);
  }

  /**
   * When this device next changes on its own.
   *
   * The scheduler stops here so an echo pulse begins and ends at the microsecond the datasheet
   * says, rather than being rounded to whenever the solver happened to look.
   */
  nextEventTime(now: number): number | null {
    if (!this.echoWindow) return null;
    if (now < this.echoWindow.start) return this.echoWindow.start;
    if (now < this.echoWindow.end) return this.echoWindow.end;
    return null;
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Turn a manifest into a part the registry and canvas understand.
 *
 * The returned definition builds a `ManifestDevice` plus real `Led` and `Resistor` devices for the
 * pin models that deserve their own Newton treatment.
 */
export function manifestToPartDefinition(
  manifest: ComponentManifest,
  options: { supplyVolts?: number } = {},
): PartDefinition {
  const supplyVolts = options.supplyVolts ?? 5;
  const layout = normaliseLayout(manifest);

  const pins: PartPin[] = layout.pins.map((pin) => ({
    name: pin.name,
    x: pin.x,
    y: pin.y,
    label: pin.description ? `${pin.name} — ${pin.description}` : pin.name,
  }));

  const defaults: Record<string, unknown> = {};
  for (const variable of manifest.state) defaults[variable.name] = variable.default;

  return {
    type: manifest.id,
    label: manifest.name,
    category: mapCategory(manifest.category),
    width: layout.width,
    height: layout.height,
    pins,
    defaults,
    appearance: {
      bodyColor: manifest.package.bodyColor,
      title: manifest.partNumber || manifest.name,
      ...(manifest.package.type ? { subtitle: manifest.package.type } : {}),
      generated: manifest.provenance.source === 'datasheet-ai',
    },
    build(ctx) {
      const state = new ComponentState(manifest.state);
      for (const variable of manifest.state) {
        const supplied = ctx.props[variable.name];
        if (typeof supplied === 'number') state.set(variable.name, supplied);
      }

      const nodes = new Map<string, number>();
      for (const pin of layout.pins) nodes.set(pin.name, ctx.node(pin.name));

      // Pin models that are really their own component get real devices, so a built-in LED gets
      // the same Newton treatment as one the user placed.
      for (const pin of manifest.pins) {
        if (pin.model.kind === 'led') {
          ctx.add(
            new Led(
              `${ctx.partId}:${pin.name}`,
              nodes.get(pin.name)!,
              nodes.get(pin.model.cathodePin) ?? GROUND,
              pin.model.color,
              { nominalCurrent: pin.model.ifNominalA, maxCurrent: pin.model.ifMaxA },
            ),
          );
        }
      }

      ctx.add(new ManifestDevice(ctx.partId, { manifest, state, nodes, supplyVolts }));
    },
  };
}

/** Smallest body the canvas can render legibly, millimetres. */
const MIN_BODY_MM = 6;
/** Clearance kept between a pin and the body's edge. */
const PIN_MARGIN_MM = 1.2;

/**
 * Bring pins and package into agreement.
 *
 * Extraction frequently lays pins out around an origin rather than from a corner, so some come
 * back negative -- which draws them outside the body, or off it entirely. Rather than reject an
 * otherwise good manifest, shift everything into the positive quadrant and grow the package to
 * contain it. The validator still warns, so the user knows the datasheet's drawing was not
 * followed literally, but the part is usable.
 */
function normaliseLayout(manifest: ComponentManifest): {
  pins: ComponentManifest['pins'];
  width: number;
  height: number;
} {
  const xs = manifest.pins.map((pin) => pin.x);
  const ys = manifest.pins.map((pin) => pin.y);
  const minX = Math.min(0, ...xs);
  const minY = Math.min(0, ...ys);

  // Shift so nothing is negative, leaving a margin so pins sit on the body rather than its edge.
  const dx = minX < 0 ? -minX + PIN_MARGIN_MM : 0;
  const dy = minY < 0 ? -minY + PIN_MARGIN_MM : 0;

  const pins = dx === 0 && dy === 0
    ? manifest.pins
    : manifest.pins.map((pin) => ({ ...pin, x: pin.x + dx, y: pin.y + dy }));

  const maxX = Math.max(...pins.map((pin) => pin.x));
  const maxY = Math.max(...pins.map((pin) => pin.y));

  return {
    pins,
    width: Math.max(MIN_BODY_MM, manifest.package.widthMm, maxX + PIN_MARGIN_MM),
    height: Math.max(MIN_BODY_MM, manifest.package.heightMm, maxY + PIN_MARGIN_MM),
  };
}

function mapCategory(category: ComponentManifest['category']): PartDefinition['category'] {
  switch (category) {
    case 'sensor':
      return 'input';
    case 'actuator':
    case 'display':
      return 'output';
    case 'passive':
      return 'passive';
    case 'power':
      return 'power';
    default:
      return 'output';
  }
}
