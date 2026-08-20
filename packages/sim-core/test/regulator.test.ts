/**
 * Linear regulators.
 *
 * Checked against what a datasheet promises and against the two ways the promise is broken in
 * practice: not enough input voltage to regulate, and too much of it to survive. Both produce a
 * circuit that is correct on paper, which is exactly why they need simulating.
 */
import { describe, expect, it } from 'vitest';
import {
  Circuit,
  GROUND,
  LinearRegulator,
  REGULATOR_7805,
  REGULATOR_AMS1117_33,
  Resistor,
  VoltageSource,
} from '../src/index.js';

/** Regulator fed from a bench supply with a resistive load, the datasheet's own test setup. */
function supplyAndLoad(inputVolts: number, loadOhms: number, model = REGULATOR_7805) {
  const circuit = new Circuit();
  const [input, output] = circuit.addNodes(2);
  circuit.add(new VoltageSource('VIN', input!, GROUND, inputVolts));
  const reg = circuit.add(new LinearRegulator('U1', input!, output!, GROUND, model));
  circuit.add(new Resistor('RL', output!, GROUND, loadOhms));
  circuit.solve();
  return { circuit, reg, input: input!, output: output! };
}

describe('linear regulator', () => {
  it('holds its output across a wide input range', () => {
    // The whole purpose of the part: 9 V and 12 V in both give 5 V out.
    for (const vin of [7.5, 9, 12, 20]) {
      const { circuit, output } = supplyAndLoad(vin, 100);
      expect(circuit.voltage(output)).toBeCloseTo(5, 2);
    }
  });

  it('delivers the current the load asks for', () => {
    const { reg, circuit, output } = supplyAndLoad(12, 100);
    expect(reg.outputCurrent).toBeCloseTo(0.05, 3);
    expect(circuit.voltage(output) / 100).toBeCloseTo(reg.outputCurrent, 3);
  });

  it('sags by exactly the dropout when the input is too low', () => {
    // Six volts into a 7805 gives four out, not five. The single most common reason a project
    // powered from a battery pack behaves nothing like the same one on a bench supply.
    const { circuit, reg, output } = supplyAndLoad(6, 100);
    expect(reg.inDropout).toBe(true);
    expect(circuit.voltage(output)).toBeCloseTo(4, 1);
  });

  it('is out of dropout as soon as it has the headroom', () => {
    const { reg, circuit, output } = supplyAndLoad(7.5, 100);
    expect(reg.inDropout).toBe(false);
    expect(circuit.voltage(output)).toBeCloseTo(5, 2);
  });

  it('reports dropout as a fault naming both voltages', () => {
    const { reg } = supplyAndLoad(6, 100);
    const found = reg.faults(0).find((f) => f.code === 'regulator-dropout');
    expect(found).toBeDefined();
    expect(found!.message).toContain('7.00 V');
  });

  it('limits its current rather than delivering whatever is asked', () => {
    // A 1 ohm load would want five amps. The part gives one and lets the output collapse.
    const { reg, circuit, output } = supplyAndLoad(12, 1);
    expect(reg.currentLimited).toBe(true);
    expect(reg.outputCurrent).toBeLessThanOrEqual(REGULATOR_7805.maxOutputAmps * 1.05);
    expect(circuit.voltage(output)).toBeLessThan(1.5);
  });

  it('survives a dead short without the solver falling over', () => {
    const { reg, circuit, output } = supplyAndLoad(12, 0.01);
    expect(reg.outputCurrent).toBeLessThanOrEqual(REGULATOR_7805.maxOutputAmps * 1.05);
    expect(circuit.voltage(output)).toBeLessThan(0.1);
  });

  it('draws its quiescent current with nothing connected', () => {
    // Small, constant, and the reason a linear regulator flattens a battery it is not even using.
    const { reg } = supplyAndLoad(12, 1e7);
    expect(reg.dissipationWatts).toBeCloseTo(12 * REGULATOR_7805.quiescentAmps, 3);
  });

  it('turns the whole of the voltage it drops into heat', () => {
    // 12 in, 5 out, 100 mA: seven volts times a tenth of an amp, plus the quiescent draw.
    const { reg } = supplyAndLoad(12, 50);
    expect(reg.outputCurrent).toBeCloseTo(0.1, 2);
    expect(reg.dissipationWatts).toBeCloseTo(7 * 0.1 + 12 * 0.005, 2);
  });

  it('returns the load current through its ground pin', () => {
    // Not a detail: it is why the dissipation appears in this one part and why the tab is what
    // gets hot. Ground carries the load current back plus whatever the regulator used itself.
    const circuit = new Circuit();
    const [input, output, ground] = circuit.addNodes(3);
    circuit.add(new VoltageSource('VIN', input!, GROUND, 12));
    const reg = circuit.add(new LinearRegulator('U1', input!, output!, ground!, REGULATOR_7805));
    circuit.add(new Resistor('RL', output!, ground!, 100));
    // The regulator's ground pin reaches the supply's return through a shunt, so its current shows.
    circuit.add(new Resistor('shunt', ground!, GROUND, 0.001));
    circuit.solve();

    const groundCurrent = circuit.voltage(ground!) / 0.001;
    expect(groundCurrent).toBeCloseTo(reg.outputCurrent + REGULATOR_7805.quiescentAmps, 3);
  });

  describe('its readout', () => {
    it('reports the numbers no probe can measure', () => {
      const { reg } = supplyAndLoad(12, 100);
      const values = Object.fromEntries(reg.readout().map((r) => [r.label, r.value]));

      expect(values.Status).toBe('regulating');
      expect(values.Output).toBe('5.00 V');
      expect(values.Dropping).toBe('7.00 V');
      expect(values.Junction).toBe('25 C');
      expect(reg.readout().every((r) => !r.alarm)).toBe(true);
    });

    it('marks the value that is the problem', () => {
      // 12 V at 333 mA settles well past shutdown, and it is the settling temperature -- not the
      // present one -- that says so.
      const { reg } = supplyAndLoad(12, 15);
      const settles = reg.readout().find((r) => r.label === 'Settles at')!;
      expect(settles.alarm).toBe(true);
      expect(reg.readout().find((r) => r.label === 'Junction')!.alarm).toBeFalsy();
    });

    it('names dropout as the status', () => {
      const { reg } = supplyAndLoad(6, 100);
      const status = reg.readout().find((r) => r.label === 'Status')!;
      expect(status.value).toBe('in dropout');
      expect(status.alarm).toBe(true);
    });
  });

  describe('thermally', () => {
    /** Run for a stretch of simulated time in steps, as the scheduler would. */
    function heat(circuit: Circuit, seconds: number, step = 0.05) {
      for (let t = 0; t < seconds; t += step) circuit.step(step);
    }

    it('warms toward the temperature its dissipation implies', () => {
      const { circuit, reg } = supplyAndLoad(12, 100);
      const settled = reg.steadyStateJunctionC;
      expect(reg.junctionTemperatureC).toBeCloseTo(25, 1);

      heat(circuit, 5);
      expect(reg.junctionTemperatureC).toBeGreaterThan(25);
      expect(reg.junctionTemperatureC).toBeLessThan(settled);
    });

    it('is fine dropping a little', () => {
      // 7.5 V in, 50 mA out: a quarter of a watt, and nowhere near a problem.
      const { reg } = supplyAndLoad(7.5, 100);
      expect(reg.steadyStateJunctionC).toBeLessThan(60);
      expect(reg.faults(0)).toHaveLength(0);
    });

    it('warns immediately about a load it will not survive', () => {
      // 12 V in at 333 mA: 2.4 W into a bare TO-220 is 155 degrees above ambient. The part is fine
      // right now and will not be in a minute, and the warning has to arrive while it is still
      // fine -- a simulation nobody watches for a full minute would otherwise never mention it.
      const { reg } = supplyAndLoad(12, 15);
      expect(reg.junctionTemperatureC).toBeCloseTo(25, 0);
      expect(reg.steadyStateJunctionC).toBeGreaterThan(REGULATOR_7805.thermalShutdownC);

      const found = reg.faults(0).find((f) => f.code === 'regulator-overheating');
      expect(found).toBeDefined();
      expect(found!.message).toContain('heatsink');
    });

    it('eventually shuts down, and its output collapses', () => {
      const { circuit, reg, output } = supplyAndLoad(12, 15);
      expect(circuit.voltage(output)).toBeCloseTo(5, 1);

      heat(circuit, 200, 0.2);
      expect(reg.thermalShutdown).toBe(true);
      expect(circuit.voltage(output)).toBeLessThan(0.5);
      expect(reg.faults(0).some((f) => f.code === 'regulator-thermal-shutdown')).toBe(true);
    });

    it('cycles rather than staying off, which is what makes it pulse', () => {
      // Shut down it dissipates almost nothing, so it cools, restarts twenty-five degrees below
      // the trip point, heats up and trips again. That oscillation is the observable symptom --
      // the supply pulsing on and off every minute or so, rather than failing once and staying
      // failed -- and a model that latched shutdown would never show it.
      const { circuit, reg, output } = supplyAndLoad(12, 15);

      let transitions = 0;
      let previous = reg.thermalShutdown;
      let lowestWhileRunning = 5;
      for (let t = 0; t < 300; t += 0.2) {
        circuit.step(0.2);
        if (reg.thermalShutdown !== previous) transitions++;
        previous = reg.thermalShutdown;
        if (reg.thermalShutdown) lowestWhileRunning = Math.min(lowestWhileRunning, circuit.voltage(output));
      }

      // Off, on, and off again at least.
      expect(transitions).toBeGreaterThanOrEqual(3);
      expect(lowestWhileRunning).toBeLessThan(0.5);
      expect(reg.junctionTemperatureC).toBeGreaterThan(100);
    });
  });

  describe('AMS1117-3.3', () => {
    it('makes 3.3 V from a 5 V rail', () => {
      const { circuit, output, reg } = supplyAndLoad(5, 100, REGULATOR_AMS1117_33);
      expect(circuit.voltage(output)).toBeCloseTo(3.3, 2);
      expect(reg.inDropout).toBe(false);
    });

    it('cannot make 3.3 V from a flat lithium cell', () => {
      // 3.9 V in with a 1.1 V dropout leaves 2.8 V, which is below what most 3.3 V parts need --
      // and is why "it works on USB but not on battery" is such a common report.
      const { circuit, output, reg } = supplyAndLoad(3.9, 100, REGULATOR_AMS1117_33);
      expect(reg.inDropout).toBe(true);
      expect(circuit.voltage(output)).toBeCloseTo(2.8, 1);
    });
  });
});
