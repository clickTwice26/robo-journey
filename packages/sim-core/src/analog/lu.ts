/**
 * Dense LU decomposition with partial pivoting.
 *
 * This is the innermost loop of the whole simulator: every Newton-Raphson iteration of every
 * timestep factors or re-solves through here. It is written flat and allocation-free over
 * `Float64Array` because a per-solve object allocation at a few thousand solves per second is the
 * difference between real-time and not.
 *
 * `ml-matrix` guards correctness from the test suite rather than from the hot path -- see
 * `test/lu.test.ts`, where every case is cross-checked against its `LuDecomposition`.
 *
 * Dense is the right call below a few hundred nodes. A sparse solver would win asymptotically but
 * costs a symbolic-analysis phase and far more opportunity to be subtly wrong, and circuits this
 * size do not reach the crossover.
 */

/**
 * Relative pivot threshold. A pivot smaller than this fraction of the largest entry seen during
 * factorisation means the matrix is numerically singular.
 *
 * Relative rather than absolute because MNA matrices are badly scaled by construction: a 100 MOhm
 * tri-state pin sits in the same matrix as a 25 Ohm output driver, spanning seven orders of
 * magnitude, and any fixed epsilon would be wrong at one end or the other.
 */
const PIVOT_EPSILON = 1e-14;

export class SingularMatrixError extends Error {
  constructor(readonly column: number) {
    super(`Matrix is singular at column ${column}`);
    this.name = 'SingularMatrixError';
  }
}

/**
 * A reusable dense linear solver.
 *
 * Allocate once per circuit partition, then `factor()` when the stamps change and `solve()` as
 * often as needed. Re-solving against a cached factorisation is O(n^2) against O(n^3) to refactor,
 * which is what makes a purely resistive circuit nearly free to re-evaluate.
 */
export class DenseSolver {
  readonly size: number;
  /** Row-major LU in one array; L has an implicit unit diagonal. */
  private readonly lu: Float64Array;
  /** Row permutation from partial pivoting: `pivot[i]` is the source row now at row `i`. */
  private readonly pivot: Int32Array;
  /** Scratch for forward substitution, so `solve()` allocates nothing. */
  private readonly scratch: Float64Array;
  private factored = false;

  constructor(size: number) {
    if (size < 0 || !Number.isInteger(size)) {
      throw new RangeError(`Solver size must be a non-negative integer, got ${size}`);
    }
    this.size = size;
    this.lu = new Float64Array(size * size);
    this.pivot = new Int32Array(size);
    this.scratch = new Float64Array(size);
  }

  /** True once `factor()` has succeeded and `solve()` may be called. */
  get isFactored(): boolean {
    return this.factored;
  }

  /**
   * Factor a row-major `size x size` matrix.
   *
   * The input is copied, not consumed, so callers may keep re-stamping their own matrix buffer.
   *
   * @throws {SingularMatrixError} when no usable pivot exists. In MNA this almost always means a
   *   floating subcircuit, which is why every node carries a `gmin` conductance to ground.
   */
  factor(a: Float64Array): void {
    const n = this.size;
    if (a.length !== n * n) {
      throw new RangeError(`Expected a ${n}x${n} matrix (${n * n} entries), got ${a.length}`);
    }
    this.factored = false;

    const lu = this.lu;
    const pivot = this.pivot;
    lu.set(a);
    for (let i = 0; i < n; i++) pivot[i] = i;

    // Scale the singularity test to the magnitudes actually present.
    let norm = 0;
    for (let i = 0; i < lu.length; i++) {
      const v = Math.abs(lu[i]!);
      if (v > norm) norm = v;
    }
    const tolerance = norm * PIVOT_EPSILON;

    for (let k = 0; k < n; k++) {
      // Partial pivoting: the largest magnitude in the column below the diagonal.
      let best = k;
      let bestValue = Math.abs(lu[k * n + k]!);
      for (let i = k + 1; i < n; i++) {
        const value = Math.abs(lu[i * n + k]!);
        if (value > bestValue) {
          bestValue = value;
          best = i;
        }
      }

      if (bestValue <= tolerance) throw new SingularMatrixError(k);

      if (best !== k) {
        // Swap whole rows, and record it so `solve()` can permute the RHS to match.
        const rowK = k * n;
        const rowBest = best * n;
        for (let j = 0; j < n; j++) {
          const tmp = lu[rowK + j]!;
          lu[rowK + j] = lu[rowBest + j]!;
          lu[rowBest + j] = tmp;
        }
        const tmpPivot = pivot[k]!;
        pivot[k] = pivot[best]!;
        pivot[best] = tmpPivot;
      }

      const diagonal = lu[k * n + k]!;
      for (let i = k + 1; i < n; i++) {
        const factor = lu[i * n + k]! / diagonal;
        lu[i * n + k] = factor;
        if (factor === 0) continue;
        const rowI = i * n;
        const rowK = k * n;
        for (let j = k + 1; j < n; j++) {
          lu[rowI + j] = lu[rowI + j]! - factor * lu[rowK + j]!;
        }
      }
    }

    this.factored = true;
  }

  /**
   * Solve `A x = b` using the cached factorisation.
   *
   * `x` may alias `b`. Neither is allocated here.
   */
  solve(b: Float64Array, x: Float64Array): void {
    const n = this.size;
    if (!this.factored) throw new Error('solve() called before a successful factor()');
    if (b.length !== n) throw new RangeError(`Expected RHS of length ${n}, got ${b.length}`);
    if (x.length !== n) throw new RangeError(`Expected solution of length ${n}, got ${x.length}`);

    const lu = this.lu;
    const y = this.scratch;

    // Forward substitution through L, applying the row permutation as we read b.
    for (let i = 0; i < n; i++) {
      let sum = b[this.pivot[i]!]!;
      const row = i * n;
      for (let j = 0; j < i; j++) sum -= lu[row + j]! * y[j]!;
      y[i] = sum;
    }

    // Back substitution through U.
    for (let i = n - 1; i >= 0; i--) {
      let sum = y[i]!;
      const row = i * n;
      for (let j = i + 1; j < n; j++) sum -= lu[row + j]! * x[j]!;
      x[i] = sum / lu[row + i]!;
    }
  }

  /** Factor and solve in one call, for code that does not benefit from caching. */
  factorAndSolve(a: Float64Array, b: Float64Array, x: Float64Array): void {
    this.factor(a);
    this.solve(b, x);
  }

  /** Discard the cached factorisation, forcing the next `solve()` to error until refactored. */
  invalidate(): void {
    this.factored = false;
  }
}
