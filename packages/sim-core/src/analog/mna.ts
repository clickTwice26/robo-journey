/**
 * Modified Nodal Analysis system assembly.
 *
 * Solves `A x = z`, where
 *
 *   A = [ G  B ]      x = [ v ]      z = [ i ]
 *       [ C  D ]          [ j ]          [ e ]
 *
 * `v` holds the `nodeCount` unknown node voltages, `j` holds the `branchCount` currents through
 * voltage sources (and any other device that needs a current unknown). `G` is the conductance
 * matrix; `B`/`C` are the incidence entries for those branches.
 *
 * Sign conventions, stated once because getting one backwards produces a circuit that solves
 * cleanly and is simply wrong:
 *
 *  - A **current source** `(a, b, I)` pushes current *out of* `a`, through the source, *into* `b`.
 *    Same as SPICE's `Iname n+ n- value`.
 *  - A **voltage source** `(a, b, V)` constrains `v(a) - v(b) = V`. Its branch unknown is the
 *    current flowing *from* `a`, through the source, *to* `b`. Note the sign that falls out of
 *    that: a 5 V supply feeding a 2 kOhm load reports `branchCurrent` of **-2.5 mA**, because the
 *    current physically flows the other way -- in at the negative terminal and out at the
 *    positive. Consumers wanting "current delivered by the supply" negate it.
 *  - **Ground** is `GROUND`, not a matrix row. Stamps touching it are silently skipped, which is
 *    what makes ground the reference rather than an extra equation.
 */
import { DenseSolver } from './lu.js';

/** The reference node. Not represented in the matrix. */
export const GROUND = -1;

/**
 * Conductance added from every node to ground.
 *
 * Without it, any subcircuit with no DC path to ground makes the matrix singular -- and in this
 * simulator that is not an edge case but the normal state of affairs, because a tri-stated AVR pin
 * genuinely disconnects part of the circuit. SPICE carries the same fudge for the same reason.
 * 1e-12 S is a 1 TOhm leak: far below any real component, far above the noise floor of the solve.
 */
export const GMIN = 1e-12;

export class MnaSystem {
  readonly nodeCount: number;
  readonly branchCount: number;
  readonly size: number;

  /** Row-major system matrix. */
  private readonly a: Float64Array;
  /** Right-hand side. */
  private readonly z: Float64Array;
  /** Solution vector: node voltages then branch currents. */
  private readonly x: Float64Array;
  private readonly solver: DenseSolver;
  /** Set when any stamp has changed since the last factorisation. */
  private dirty = true;
  /**
   * Conductance seeded to ground on every node at `reset()`.
   *
   * Normally `GMIN`. The gmin-stepping homotopy raises it temporarily: a heavily leaked circuit is
   * nearly linear and always converges, and walking the leak back down by decades carries the
   * solution to the real answer one easy problem at a time.
   */
  gmin = GMIN;

  constructor(nodeCount: number, branchCount = 0) {
    if (nodeCount < 0 || branchCount < 0) throw new RangeError('Counts must be non-negative');
    this.nodeCount = nodeCount;
    this.branchCount = branchCount;
    this.size = nodeCount + branchCount;
    this.a = new Float64Array(this.size * this.size);
    this.z = new Float64Array(this.size);
    this.x = new Float64Array(this.size);
    this.solver = new DenseSolver(this.size);
  }

  /**
   * Clear the matrix and RHS, then re-seed gmin.
   *
   * Called at the top of every Newton iteration: nonlinear devices restamp with new linearisation
   * points, so the system is rebuilt rather than patched.
   */
  reset(): void {
    this.a.fill(0);
    this.z.fill(0);
    for (let i = 0; i < this.nodeCount; i++) {
      this.a[i * this.size + i] = this.gmin;
    }
    this.dirty = true;
  }

  /** Conductance `g` siemens between two nodes. The workhorse stamp. */
  stampConductance(nodeA: number, nodeB: number, g: number): void {
    if (g === 0) return;
    const n = this.size;
    if (nodeA !== GROUND) this.a[nodeA * n + nodeA] = this.a[nodeA * n + nodeA]! + g;
    if (nodeB !== GROUND) this.a[nodeB * n + nodeB] = this.a[nodeB * n + nodeB]! + g;
    if (nodeA !== GROUND && nodeB !== GROUND) {
      this.a[nodeA * n + nodeB] = this.a[nodeA * n + nodeB]! - g;
      this.a[nodeB * n + nodeA] = this.a[nodeB * n + nodeA]! - g;
    }
    this.dirty = true;
  }

  /** Resistance in ohms, as a convenience over `stampConductance`. */
  stampResistance(nodeA: number, nodeB: number, ohms: number): void {
    if (!(ohms > 0)) throw new RangeError(`Resistance must be positive, got ${ohms}`);
    this.stampConductance(nodeA, nodeB, 1 / ohms);
  }

  /** Current `amps` flowing out of `nodeA`, through the source, into `nodeB`. */
  stampCurrentSource(nodeA: number, nodeB: number, amps: number): void {
    if (amps === 0) return;
    if (nodeA !== GROUND) this.z[nodeA] = this.z[nodeA]! - amps;
    if (nodeB !== GROUND) this.z[nodeB] = this.z[nodeB]! + amps;
    this.dirty = true;
  }

  /**
   * Constrain `v(nodeA) - v(nodeB) = volts` using branch unknown `branch`.
   *
   * `branch` indexes the voltage-source block, so 0 is the first source, not row 0 of the matrix.
   */
  stampVoltageSource(branch: number, nodeA: number, nodeB: number, volts: number): void {
    if (branch < 0 || branch >= this.branchCount) {
      throw new RangeError(`Branch ${branch} out of range (${this.branchCount} declared)`);
    }
    const n = this.size;
    const row = this.nodeCount + branch;

    if (nodeA !== GROUND) {
      this.a[nodeA * n + row] = this.a[nodeA * n + row]! + 1;
      this.a[row * n + nodeA] = this.a[row * n + nodeA]! + 1;
    }
    if (nodeB !== GROUND) {
      this.a[nodeB * n + row] = this.a[nodeB * n + row]! - 1;
      this.a[row * n + nodeB] = this.a[row * n + nodeB]! - 1;
    }
    this.z[row] = this.z[row]! + volts;
    this.dirty = true;
  }

  /**
   * A voltage-controlled current source: `gm * (v(ctrlA) - v(ctrlB))` flowing out of `outA`,
   * through the source, into `outB`.
   *
   * The first genuinely asymmetric stamp here. Everything before it was a two-terminal element,
   * whose contribution is symmetric about the diagonal; a transconductance couples one pair of
   * nodes to a *different* pair, which is exactly what makes an amplifying device an amplifying
   * device. Transistors are built from these.
   */
  stampVCCS(outA: number, outB: number, ctrlA: number, ctrlB: number, gm: number): void {
    if (gm === 0) return;
    const n = this.size;
    const add = (row: number, col: number, value: number) => {
      if (row === GROUND || col === GROUND) return;
      this.a[row * n + col] = this.a[row * n + col]! + value;
    };

    add(outA, ctrlA, gm);
    add(outA, ctrlB, -gm);
    add(outB, ctrlA, -gm);
    add(outB, ctrlB, gm);
    this.dirty = true;
  }

  /**
   * A voltage-controlled voltage source: `v(outA) - v(outB) = gain * (v(ctrlA) - v(ctrlB))`.
   *
   * Needs a branch unknown, because forcing a voltage means solving for the current that achieves
   * it -- the same reason an independent voltage source does. This is what an op-amp is made of.
   */
  stampVCVS(
    branch: number,
    outA: number,
    outB: number,
    ctrlA: number,
    ctrlB: number,
    gain: number,
  ): void {
    if (branch < 0 || branch >= this.branchCount) {
      throw new RangeError(`Branch ${branch} out of range (${this.branchCount} declared)`);
    }
    const n = this.size;
    const row = this.nodeCount + branch;
    const add = (r: number, c: number, value: number) => {
      if (r === GROUND || c === GROUND) return;
      this.a[r * n + c] = this.a[r * n + c]! + value;
    };

    // Incidence: the branch current flows out of outA and into outB.
    add(outA, row, 1);
    add(outB, row, -1);
    // Constraint: v(outA) - v(outB) - gain * (v(ctrlA) - v(ctrlB)) = 0.
    add(row, outA, 1);
    add(row, outB, -1);
    add(row, ctrlA, -gain);
    add(row, ctrlB, gain);

    this.dirty = true;
  }

  /**
   * Add a constant to a branch's right-hand side.
   *
   * A controlled source that has been linearised about an operating point has a constant term as
   * well as a gain, and it has to land on the branch's constraint row rather than on a node.
   */
  stampVoltageSourceOffset(branch: number, volts: number): void {
    if (branch < 0 || branch >= this.branchCount) {
      throw new RangeError(`Branch ${branch} out of range (${this.branchCount} declared)`);
    }
    const row = this.nodeCount + branch;
    this.z[row] = this.z[row]! + volts;
    this.dirty = true;
  }

  /**
   * A Norton pair: conductance `g` in parallel with current source `ieq`.
   *
   * This is the shape every linearised nonlinear device and every reactive companion model reduces
   * to, so it is worth having as one call. `ieq` is the current the source drives *into* `nodeA`.
   */
  stampNorton(nodeA: number, nodeB: number, g: number, ieq: number): void {
    this.stampConductance(nodeA, nodeB, g);
    this.stampCurrentSource(nodeB, nodeA, ieq);
  }

  /**
   * Factor and solve.
   *
   * When nothing has been restamped since the last call the cached factorisation is reused and only
   * back-substitution runs -- O(n^2) rather than O(n^3). That is what makes a static resistive
   * network nearly free to re-evaluate between events.
   */
  solve(): void {
    if (this.size === 0) return;
    if (this.dirty || !this.solver.isFactored) {
      this.solver.factor(this.a);
      this.dirty = false;
    }
    this.solver.solve(this.z, this.x);
  }

  /** Voltage at a node. `GROUND` is always exactly zero. */
  voltage(node: number): number {
    if (node === GROUND) return 0;
    if (node < 0 || node >= this.nodeCount) throw new RangeError(`No such node ${node}`);
    return this.x[node]!;
  }

  /**
   * Current through a voltage-source branch, flowing from `nodeA` through the source to `nodeB`.
   *
   * Negative for a source that is delivering power -- see the sign note in the file header.
   */
  branchCurrent(branch: number): number {
    if (branch < 0 || branch >= this.branchCount) throw new RangeError(`No such branch ${branch}`);
    return this.x[this.nodeCount + branch]!;
  }

  /** Copy of the solution vector, for tests and debugging. */
  solution(): Float64Array {
    return this.x.slice();
  }

  /** Copy of the assembled matrix, for tests and debugging. */
  matrix(): Float64Array {
    return this.a.slice();
  }

  /** Copy of the right-hand side, for tests and debugging. */
  rhs(): Float64Array {
    return this.z.slice();
  }
}
