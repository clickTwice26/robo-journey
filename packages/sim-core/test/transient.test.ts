/**
 * Reactive devices, against closed-form answers.
 *
 * An RC charging curve is the one circuit result everyone remembers, which makes it the best
 * possible check on the companion models and the timestepping around them: if `v(tau)` is not
 * 63.2% of the supply, something is wrong and it is obvious.
 */
import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/analog/circuit.js';
import { GROUND } from '../src/analog/mna.js';
import { Capacitor, Inductor, Resistor, VoltageSource } from '../src/analog/devices.js';

/** Run `seconds` of simulated time at a fixed step, returning the circuit for inspection. */
function advance(circuit: Circuit, seconds: number, dt: number): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) circuit.step(dt);
}

describe('transient analysis', () => {
  describe('RC charging', () => {
    /** 5 V -> 1k -> 1uF -> GND. tau = 1 ms. */
    function rc(method: 'trapezoidal' | 'backward-euler' = 'trapezoidal') {
      const circuit = new Circuit();
      const [rail, cap] = circuit.addNodes(2);
      circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
      circuit.add(new Resistor('R1', rail!, cap!, 1000));
      const capacitor = circuit.add(new Capacitor('C1', cap!, GROUND, 1e-6, method));
      return { circuit, capacitor, node: cap! };
    }

    it('charges to the supply at the DC operating point', () => {
      const { circuit, node } = rc();
      circuit.solve();
      // Steady state, not power-on: with the capacitor an open circuit no current flows, so the
      // resistor drops nothing and the capacitor sits at the full supply. This is the textbook
      // `.op` answer and it is deliberately NOT where a transient run starts.
      expect(circuit.voltage(node)).toBeCloseTo(5, 6);
    });

    it('starts from rest when stepped without a prior operating-point solve', () => {
      // Power-on is the case that matters for us: a real board's capacitors are discharged when
      // the regulator comes up, so a transient run must begin there rather than at steady state.
      const { circuit, node } = rc();
      circuit.step(1e-6);
      expect(circuit.voltage(node)).toBeLessThan(0.01);
    });

    it('reaches 63.2% of the supply after one time constant', () => {
      const { circuit, node } = rc();
      advance(circuit, 1e-3, 1e-6);
      // 5 * (1 - 1/e) = 3.1606 V
      expect(circuit.voltage(node)).toBeCloseTo(5 * (1 - Math.exp(-1)), 3);
    });

    it('follows the exponential across several time constants', () => {
      for (const taus of [1, 2, 3, 5]) {
        const { circuit, node } = rc();
        advance(circuit, taus * 1e-3, 1e-6);
        expect(circuit.voltage(node)).toBeCloseTo(5 * (1 - Math.exp(-taus)), 3);
      }
    });

    it('agrees between trapezoidal and backward Euler at a fine timestep', () => {
      const trap = rc('trapezoidal');
      const be = rc('backward-euler');
      advance(trap.circuit, 1e-3, 1e-7);
      advance(be.circuit, 1e-3, 1e-7);

      expect(trap.circuit.voltage(trap.node)).toBeCloseTo(be.circuit.voltage(be.node), 3);
    });

    it('is more accurate with trapezoidal at a coarse timestep', () => {
      // Second-order against first-order: at dt = tau/10 the difference should be visible, and
      // trapezoidal should be the one closer to the analytic answer.
      const exact = 5 * (1 - Math.exp(-1));
      const trap = rc('trapezoidal');
      const be = rc('backward-euler');
      advance(trap.circuit, 1e-3, 1e-4);
      advance(be.circuit, 1e-3, 1e-4);

      const trapError = Math.abs(trap.circuit.voltage(trap.node) - exact);
      const beError = Math.abs(be.circuit.voltage(be.node) - exact);
      expect(trapError).toBeLessThan(beError);
    });

    it('converges toward the supply and stops there', () => {
      const { circuit, node } = rc();
      advance(circuit, 20e-3, 1e-6);
      expect(circuit.voltage(node)).toBeCloseTo(5, 4);
    });

    it('conserves charge on discharge', () => {
      // Charge to 5 V, then swap the supply to 0 V and watch it fall through the same tau.
      const circuit = new Circuit();
      const [rail, cap] = circuit.addNodes(2);
      const supply = circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
      circuit.add(new Resistor('R1', rail!, cap!, 1000));
      circuit.add(new Capacitor('C1', cap!, GROUND, 1e-6));

      // 20 tau leaves the residual well below the assertion's resolution.
      advance(circuit, 20e-3, 1e-6);
      expect(circuit.voltage(cap!)).toBeCloseTo(5, 4);

      supply.volts = 0;
      // A supply stepping to zero is a discontinuity: without this the trapezoidal rule carries
      // the pre-step current across the jump and the answer drifts by about a millivolt.
      circuit.markDiscontinuity();
      advance(circuit, 1e-3, 1e-6);
      // One tau of decay leaves 1/e of the original.
      expect(circuit.voltage(cap!)).toBeCloseTo(5 * Math.exp(-1), 4);
    });
  });

  describe('RL', () => {
    it('rises toward its final current with the right time constant', () => {
      // 5 V -> 100R -> 10 mH -> GND. tau = L/R = 100 us, final current = 50 mA.
      const circuit = new Circuit();
      const [rail, mid] = circuit.addNodes(2);
      circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
      circuit.add(new Resistor('R1', rail!, mid!, 100));
      const inductor = circuit.add(new Inductor('L1', mid!, GROUND, 10e-3));

      advance(circuit, 100e-6, 1e-8);
      expect(inductor.current).toBeCloseTo(0.05 * (1 - Math.exp(-1)), 3);

      advance(circuit, 400e-6, 1e-8);
      expect(inductor.current).toBeCloseTo(0.05, 3);
    });

    it('behaves as a short at DC', () => {
      const circuit = new Circuit();
      const [rail, mid] = circuit.addNodes(2);
      circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
      circuit.add(new Resistor('R1', rail!, mid!, 100));
      circuit.add(new Inductor('L1', mid!, GROUND, 10e-3));
      circuit.solve();

      // A short to ground pulls the node to within a millivolt of zero.
      expect(circuit.voltage(mid!)).toBeLessThan(0.001);
    });
  });

  describe('discontinuities', () => {
    it('is more accurate across a supply step when the discontinuity is declared', () => {
      // The same discharge, run both ways. Declaring the jump must measurably beat not declaring
      // it -- this is the guard on a correctness property that is otherwise invisible.
      function discharge(declare: boolean): number {
        const circuit = new Circuit();
        const [rail, cap] = circuit.addNodes(2);
        const supply = circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
        circuit.add(new Resistor('R1', rail!, cap!, 1000));
        circuit.add(new Capacitor('C1', cap!, GROUND, 1e-6));

        advance(circuit, 20e-3, 1e-6);
        supply.volts = 0;
        if (declare) circuit.markDiscontinuity();
        advance(circuit, 1e-3, 1e-6);
        return Math.abs(circuit.voltage(cap!) - 5 * Math.exp(-1));
      }

      expect(discharge(true)).toBeLessThan(discharge(false));
    });

    it('returns to second-order accuracy after absorbing the step', () => {
      // One damped step, then trapezoidal again -- the long-run answer must still be exact.
      const circuit = new Circuit();
      const [rail, cap] = circuit.addNodes(2);
      const supply = circuit.add(new VoltageSource('V1', rail!, GROUND, 0));
      circuit.add(new Resistor('R1', rail!, cap!, 1000));
      circuit.add(new Capacitor('C1', cap!, GROUND, 1e-6));

      advance(circuit, 1e-3, 1e-6);
      supply.volts = 5;
      circuit.markDiscontinuity();
      advance(circuit, 1e-3, 1e-6);

      expect(circuit.voltage(cap!)).toBeCloseTo(5 * (1 - Math.exp(-1)), 4);
    });
  });

  describe('validation', () => {
    it('rejects non-positive component values', () => {
      expect(() => new Capacitor('C1', 0, GROUND, 0)).toThrow(RangeError);
      expect(() => new Inductor('L1', 0, GROUND, -1)).toThrow(RangeError);
    });

    it('rejects a non-positive timestep', () => {
      const circuit = new Circuit();
      expect(() => circuit.step(0)).toThrow(RangeError);
      expect(() => circuit.step(-1e-6)).toThrow(RangeError);
    });

    it('returns to the initial state on reset', () => {
      const circuit = new Circuit();
      const [rail, cap] = circuit.addNodes(2);
      circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
      circuit.add(new Resistor('R1', rail!, cap!, 1000));
      const capacitor = circuit.add(new Capacitor('C1', cap!, GROUND, 1e-6));

      advance(circuit, 5e-3, 1e-6);
      expect(capacitor.voltage).toBeGreaterThan(4.9);

      circuit.reset();
      expect(capacitor.voltage).toBe(0);
    });
  });
});
