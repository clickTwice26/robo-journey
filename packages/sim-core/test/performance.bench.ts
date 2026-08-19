/**
 * Real-time performance.
 *
 * The product requirement is simple: the engine must simulate MCU time at least as fast as MCU
 * time passes, or the UI cannot run the sketch live. The plan named a ~60-node circuit as the
 * bar, and failing it is the documented trigger for porting the solver to Rust/WASM.
 *
 * The threshold here is the requirement itself (1.0x), not the measured figure, so this stays a
 * meaningful gate on a slow CI box rather than a flaky assertion about one developer's laptop.
 *
 * Run by `npm run bench`, never as part of the ordinary suite: vitest runs test files in parallel,
 * and a wall-clock measurement taken while eleven other files compete for cores reports CPU
 * contention rather than solver speed. The same circuit read 0.81x under load and 2.05x alone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Board, GROUND, Led, Resistor, loadHex } from '../src/index.js';

const blinkHex = readFileSync(
  fileURLToPath(new URL('./fixtures/blink.hex', import.meta.url)),
  'utf8',
);

/** Simulated seconds per wall-clock second. Above 1.0 means faster than real time. */
function realtimeRatio(build: (board: Board) => void, simSeconds = 0.25): number {
  const board = new Board({ progMem: loadHex(blinkHex) });
  build(board);

  // Warm up, so JIT compilation does not land inside the measurement.
  board.runFor(0.01);

  const start = performance.now();
  board.runFor(simSeconds);
  return simSeconds / ((performance.now() - start) / 1000);
}

describe('real-time performance', () => {
  it('runs a bare board faster than real time', () => {
    expect(realtimeRatio(() => {})).toBeGreaterThan(1);
  });

  it('runs an LED circuit faster than real time', () => {
    expect(
      realtimeRatio((board) => {
        const anode = board.circuit.addNode();
        board.circuit.add(new Resistor('R1', board.node('D13'), anode, 220));
        board.circuit.add(new Led('D1', anode, GROUND, 'red'));
      }),
    ).toBeGreaterThan(1);
  });

  it('holds real time on a ~55-node circuit with 14 LEDs and 6 dividers', () => {
    // The plan's stated bar. Nonlinear devices dominate the cost here: each LED forces Newton
    // iterations that a purely resistive network would skip entirely.
    const ratio = realtimeRatio((board) => {
      for (let i = 0; i < 14; i++) {
        const anode = board.circuit.addNode();
        board.circuit.add(new Resistor(`R${i}`, board.node(`D${i}`), anode, 220));
        board.circuit.add(new Led(`L${i}`, anode, GROUND, 'red'));
      }
      for (let i = 0; i < 6; i++) {
        const tap = board.circuit.addNode();
        board.circuit.add(new Resistor(`Rt${i}`, board.vcc, tap, 10_000));
        board.circuit.add(new Resistor(`Rb${i}`, tap, GROUND, 10_000));
        board.circuit.add(new Resistor(`Ra${i}`, tap, board.node(`A${i}`), 1000));
      }
    });

    expect(ratio).toBeGreaterThan(1);
  });
});
