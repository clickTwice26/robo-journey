/**
 * Dense LU, cross-checked against `ml-matrix`.
 *
 * The hand-rolled solver runs in the hot path; the battle-tested library runs here. Every random
 * system below is solved both ways and the results must agree, so a numerics regression fails
 * loudly instead of quietly producing plausible-but-wrong voltages.
 */
import { Matrix, LuDecomposition } from 'ml-matrix';
import { describe, expect, it } from 'vitest';
import { DenseSolver, SingularMatrixError } from '../src/analog/lu.js';

/** Deterministic PRNG: a failing case must be reproducible from the seed alone. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function toRowMajor(rows: number[][]): Float64Array {
  return Float64Array.from(rows.flat());
}

/** Solve with ml-matrix, the independent oracle. */
function oracleSolve(rows: number[][], b: number[]): number[] {
  return new LuDecomposition(new Matrix(rows)).solve(Matrix.columnVector(b)).to1DArray();
}

function solveWith(rows: number[][], b: number[]): number[] {
  const solver = new DenseSolver(rows.length);
  const x = new Float64Array(rows.length);
  solver.factorAndSolve(toRowMajor(rows), Float64Array.from(b), x);
  return [...x];
}

/** Relative comparison: MNA solutions span many orders of magnitude. */
function expectClose(actual: number[], expected: number[], tolerance = 1e-9): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const scale = Math.max(1, Math.abs(expected[i]!));
    expect(Math.abs(actual[i]! - expected[i]!) / scale).toBeLessThan(tolerance);
  }
}

describe('DenseSolver', () => {
  it('solves a 2x2 system with a hand-checkable answer', () => {
    // 2x + y = 3 ; x + 3y = 5  ->  x = 0.8, y = 1.4
    expectClose(solveWith([[2, 1], [1, 3]], [3, 5]), [0.8, 1.4]);
  });

  it('agrees with ml-matrix on the same 2x2', () => {
    const rows = [[2, 1], [1, 3]];
    expectClose(solveWith(rows, [3, 5]), oracleSolve(rows, [3, 5]));
  });

  it('handles the identity matrix', () => {
    expectClose(solveWith([[1, 0], [0, 1]], [7, -3]), [7, -3]);
  });

  it('pivots when the leading entry is zero', () => {
    // Without partial pivoting this divides by zero on the very first column.
    const rows = [[0, 2], [3, 1]];
    const b = [4, 5];
    expectClose(solveWith(rows, b), oracleSolve(rows, b));
  });

  it('agrees with ml-matrix across many random dense systems', () => {
    const random = lcg(0xc0ffee);
    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + (trial % 9);
      const rows: number[][] = [];
      for (let i = 0; i < n; i++) {
        const row: number[] = [];
        // Diagonally dominant, like a real conductance matrix, so the system is well conditioned.
        for (let j = 0; j < n; j++) row.push(random() * 2 - 1);
        row[i] = row[i]! + n;
        rows.push(row);
      }
      const b = Array.from({ length: n }, () => random() * 20 - 10);
      expectClose(solveWith(rows, b), oracleSolve(rows, b), 1e-8);
    }
  });

  it('agrees with ml-matrix on badly scaled matrices, as MNA produces', () => {
    // A 25 Ohm output driver and a 100 MOhm tri-state input in one matrix: seven orders of
    // magnitude apart. This is the normal case for us, not a pathological one.
    const rows = [
      [1 / 25 + 1e-8, -1e-8, 0],
      [-1e-8, 1e-8 + 1 / 220, -1 / 220],
      [0, -1 / 220, 1 / 220 + 1e-12],
    ];
    const b = [5 / 25, 0, 0];
    expectClose(solveWith(rows, b), oracleSolve(rows, b), 1e-6);
  });

  it('reuses a cached factorisation across right-hand sides', () => {
    const rows = [[4, 1, 2], [1, 5, 1], [2, 1, 6]];
    const solver = new DenseSolver(3);
    solver.factor(toRowMajor(rows));

    // The whole point of caching: many solves, one factorisation.
    for (const b of [[1, 2, 3], [0, 0, 1], [-5, 7, 2]]) {
      const x = new Float64Array(3);
      solver.solve(Float64Array.from(b), x);
      expectClose([...x], oracleSolve(rows, b));
    }
  });

  it('allows the solution to alias the right-hand side', () => {
    const rows = [[3, 1], [1, 2]];
    const solver = new DenseSolver(2);
    solver.factor(toRowMajor(rows));
    const shared = Float64Array.from([5, 5]);
    solver.solve(shared, shared);
    expectClose([...shared], oracleSolve(rows, [5, 5]));
  });

  it('detects a singular matrix rather than returning nonsense', () => {
    const solver = new DenseSolver(2);
    // Second row is twice the first: rank 1.
    expect(() => solver.factor(toRowMajor([[1, 2], [2, 4]]))).toThrow(SingularMatrixError);
  });

  it('detects a floating subcircuit, the singular case MNA actually hits', () => {
    // Two nodes joined only to each other, with no path to ground: exactly what an unconnected
    // component looks like before gmin is stamped.
    const g = 1 / 1000;
    const solver = new DenseSolver(2);
    expect(() => solver.factor(toRowMajor([[g, -g], [-g, g]]))).toThrow(SingularMatrixError);
  });

  it('stays solvable once gmin is added to that same floating subcircuit', () => {
    // gmin is the fix, and this is the test that proves it. Voltages are meaningless here; not
    // throwing is the whole assertion.
    const g = 1 / 1000;
    const gmin = 1e-12;
    const rows = [[g + gmin, -g], [-g, g + gmin]];
    expect(() => solveWith(rows, [0, 0])).not.toThrow();
  });

  it('refuses to solve before factoring', () => {
    const solver = new DenseSolver(2);
    expect(() => solver.solve(new Float64Array(2), new Float64Array(2))).toThrow(/before a successful factor/);
  });

  it('invalidate() forces a refactor', () => {
    const solver = new DenseSolver(2);
    solver.factor(toRowMajor([[2, 0], [0, 2]]));
    expect(solver.isFactored).toBe(true);
    solver.invalidate();
    expect(solver.isFactored).toBe(false);
    expect(() => solver.solve(new Float64Array(2), new Float64Array(2))).toThrow();
  });

  it('validates dimensions', () => {
    const solver = new DenseSolver(3);
    expect(() => solver.factor(new Float64Array(4))).toThrow(RangeError);
    solver.factor(toRowMajor([[1, 0, 0], [0, 1, 0], [0, 0, 1]]));
    expect(() => solver.solve(new Float64Array(2), new Float64Array(3))).toThrow(RangeError);
    expect(() => solver.solve(new Float64Array(3), new Float64Array(2))).toThrow(RangeError);
  });

  it('handles a 1x1 system', () => {
    expectClose(solveWith([[4]], [8]), [2]);
  });
});
