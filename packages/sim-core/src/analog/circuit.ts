/**
 * The circuit: device list, Newton-Raphson loop, and the homotopy fallbacks that rescue it.
 *
 * Convergence is the whole game here. A linear circuit solves in one shot; add a single diode and
 * the solve becomes an iterative root-find that can and does fail. Three defences, in escalating
 * order of desperation:
 *
 *   1. `pnjlim` junction limiting inside each nonlinear device, bounding per-iteration movement.
 *   2. gmin stepping -- leak every node to ground, solve the easy problem, walk the leak down.
 *   3. source stepping -- start every supply at zero and ramp to full.
 *
 * SPICE carries the same three for the same reason. Most circuits never leave step 1.
 */
import { GMIN, GROUND, MnaSystem } from './mna.js';
import { MAX_NEWTON_ITERATIONS, RELTOL, VNTOL } from './constants.js';
import type { Device, StampContext } from './devices.js';
import { SingularMatrixError } from './lu.js';

export interface SolveResult {
  readonly converged: boolean;
  readonly iterations: number;
  /** Which strategy produced the answer, for diagnostics and tests. */
  readonly method: 'direct' | 'gmin-stepping' | 'source-stepping';
}

export class ConvergenceError extends Error {
  constructor(readonly iterations: number) {
    super(
      `Circuit failed to converge after ${iterations} iterations, including gmin and source ` +
        `stepping. This usually means a floating node or a contradictory connection.`,
    );
    this.name = 'ConvergenceError';
  }
}

/** gmin-stepping ladder: from a heavy 1 mS leak down to the normal 1 pS. */
const GMIN_LADDER = [1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8, 1e-9, 1e-10, 1e-11, GMIN];

/** Source-stepping ramp, as a fraction of full supply voltage. */
const SOURCE_LADDER = [0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.95, 1];

export class Circuit {
  private readonly devices: Device[] = [];
  private nodeCount = 0;
  private branchCount = 0;
  private mna: MnaSystem | null = null;

  /** Node voltages from the previous Newton iteration -- what devices linearise around. */
  private previous = new Float64Array(0);
  private hasNonlinear = false;
  private iterationRequested = false;
  /** Scales every independent source, for source stepping. 1 in normal operation. */
  private sourceScale = 1;
  /** Consumed by the next `step()`, forcing one damped Backward Euler step. */
  private discontinuityPending = true;

  /** Allocate a new circuit node. */
  addNode(): number {
    return this.nodeCount++;
  }

  /** Allocate several nodes at once. */
  addNodes(count: number): number[] {
    return Array.from({ length: count }, () => this.addNode());
  }

  /** Register a device, assigning it any branch unknowns and internal nodes it needs. */
  add<T extends Device>(device: T): T {
    device.branchOffset = this.branchCount;
    this.branchCount += device.branchCount;
    if (device.internalNodeCount > 0) {
      device.internalNodeOffset = this.nodeCount;
      this.nodeCount += device.internalNodeCount;
    }
    if (device.nonlinear) this.hasNonlinear = true;
    this.devices.push(device);
    // Adding a device invalidates the matrix shape.
    this.mna = null;
    return device;
  }

  /** Every registered device, in insertion order. */
  get allDevices(): readonly Device[] {
    return this.devices;
  }

  get nodes(): number {
    return this.nodeCount;
  }

  /**
   * Node voltage from the last converged solve, or 0 before the first one.
   *
   * Returning 0 rather than `undefined` for an unsolved circuit matters: a freshly built circuit
   * is genuinely at rest, and callers reading a node before the first solve should see a rest
   * state, not a hole in the type system.
   */
  voltage(node: number): number {
    if (node === GROUND) return 0;
    if (node < 0 || node >= this.nodeCount) throw new RangeError(`No such node ${node}`);
    return this.previous[node] ?? 0;
  }

  /** All node voltages from the last converged solve. */
  voltages(): Float64Array {
    return this.previous.slice();
  }

  /** The underlying system, for reading branch currents. */
  get system(): MnaSystem {
    return this.ensureSystem();
  }

  /** Return every device to its power-on state and clear the solution. */
  reset(): void {
    for (const device of this.devices) device.reset?.();
    this.previous = new Float64Array(this.nodeCount);
    this.sourceScale = 1;
    this.discontinuityPending = true;
    if (this.mna) this.mna.gmin = GMIN;
  }

  /**
   * Solve the DC operating point.
   *
   * @param timestep Seconds. Zero treats reactances as DC (capacitors open, inductors shorted).
   * @throws {ConvergenceError} when all three strategies fail.
   */
  solve(timestep = 0): SolveResult {
    const direct = this.newton(timestep);
    if (direct.converged) return { ...direct, method: 'direct' };

    const stepped = this.gminStepping(timestep);
    if (stepped.converged) return { ...stepped, method: 'gmin-stepping' };

    const ramped = this.sourceStepping(timestep);
    if (ramped.converged) return { ...ramped, method: 'source-stepping' };

    throw new ConvergenceError(ramped.iterations);
  }

  /**
   * Signal that something changed discontinuously -- a supply value, a switch, a GPIO pin.
   *
   * The next `step()` integrates with Backward Euler, which absorbs the jump instead of ringing on
   * it. In this simulator that is not a rare event: every digital edge is a discontinuity.
   */
  markDiscontinuity(): void {
    this.discontinuityPending = true;
  }

  /** Advance one timestep, latching reactive state afterwards. */
  step(timestep: number): SolveResult {
    if (!(timestep > 0)) throw new RangeError(`Timestep must be positive, got ${timestep}`);
    const result = this.solve(timestep);
    const ctx = this.context(timestep, false);
    for (const device of this.devices) device.commit?.(ctx);
    // The jump has been absorbed; subsequent steps may return to second-order accuracy.
    this.discontinuityPending = false;
    return result;
  }

  // -------------------------------------------------------------------------------------------

  private ensureSystem(): MnaSystem {
    if (!this.mna || this.mna.nodeCount !== this.nodeCount) {
      this.mna = new MnaSystem(this.nodeCount, this.branchCount);
      this.previous = new Float64Array(this.nodeCount);
    }
    return this.mna;
  }

  private context(timestep: number, firstIteration: boolean): StampContext {
    const mna = this.ensureSystem();
    const previous = this.previous;
    return {
      mna,
      timestep,
      firstIteration,
      sourceScale: this.sourceScale,
      forceBackwardEuler: this.discontinuityPending,
      voltage: (node: number) => (node === GROUND ? 0 : previous[node]!),
      requestIteration: () => {
        this.iterationRequested = true;
      },
    };
  }

  /**
   * The Newton-Raphson loop.
   *
   * A linear circuit converges on the second pass by definition: the first produces the answer, the
   * second confirms nothing moved. Only nonlinear circuits iterate meaningfully.
   */
  private newton(timestep: number): { converged: boolean; iterations: number } {
    const mna = this.ensureSystem();
    const maxIterations = this.hasNonlinear ? MAX_NEWTON_ITERATIONS : 2;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      this.iterationRequested = false;
      const ctx = this.context(timestep, iteration === 0);

      mna.reset();
      for (const device of this.devices) device.stamp(ctx);

      try {
        mna.solve();
      } catch (error) {
        // A singular matrix here is a solve failure, not a crash: the caller escalates to a
        // homotopy, which is exactly the situation gmin stepping exists for.
        if (error instanceof SingularMatrixError) return { converged: false, iterations: iteration + 1 };
        throw error;
      }

      let converged = !this.iterationRequested;
      for (let node = 0; node < this.nodeCount; node++) {
        const next = mna.voltage(node);
        const delta = Math.abs(next - this.previous[node]!);
        if (delta > RELTOL * Math.abs(next) + VNTOL) converged = false;
        this.previous[node] = next;
      }

      // Never accept the very first pass: with all voltages at zero the deltas are trivially
      // small, and a nonlinear circuit would "converge" before any device had been linearised.
      if (converged && iteration > 0) return { converged: true, iterations: iteration + 1 };
    }

    return { converged: false, iterations: maxIterations };
  }

  /**
   * gmin stepping.
   *
   * Leak every node to ground hard enough that the circuit is nearly linear, solve, then walk the
   * leak down by decades. Each solve starts from the previous answer, so every individual problem
   * is easy even though the last one is the real, hard one.
   */
  private gminStepping(timestep: number): { converged: boolean; iterations: number } {
    const mna = this.ensureSystem();
    let total = 0;

    for (const gmin of GMIN_LADDER) {
      mna.gmin = gmin;
      const result = this.newton(timestep);
      total += result.iterations;
      if (!result.converged) {
        mna.gmin = GMIN;
        return { converged: false, iterations: total };
      }
    }

    mna.gmin = GMIN;
    return { converged: true, iterations: total };
  }

  /**
   * Source stepping.
   *
   * Every supply starts at zero -- where the answer is trivially all-zero -- and ramps to full.
   * Slower than gmin stepping but succeeds on circuits with strong positive feedback where a
   * uniform leak does not help.
   */
  private sourceStepping(timestep: number): { converged: boolean; iterations: number } {
    let total = 0;

    // Start from the known-good all-zero state rather than wherever the failed attempts left us.
    this.previous = new Float64Array(this.nodeCount);
    for (const device of this.devices) device.reset?.();

    for (const scale of SOURCE_LADDER) {
      this.sourceScale = scale;
      const result = this.newton(timestep);
      total += result.iterations;
      if (!result.converged) {
        this.sourceScale = 1;
        return { converged: false, iterations: total };
      }
    }

    this.sourceScale = 1;
    return { converged: true, iterations: total };
  }

  /** Current source-stepping scale, read by independent sources while stamping. */
  get scale(): number {
    return this.sourceScale;
  }
}
