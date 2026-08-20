/**
 * MOSFETs, op-amps and potentiometers.
 *
 * Checked against the numbers a datasheet or a textbook would give, and against the mistakes these
 * parts are famous for: a gate that will not turn a device fully on, an op-amp that cannot reach
 * its own supply rail, a potentiometer wired as a rheostat instead of a divider.
 */
import { describe, expect, it } from 'vitest';
import {
  Circuit,
  GROUND,
  Led,
  MOSFET_2N7000,
  MOSFET_IRLZ44N,
  Mosfet,
  OPAMP_LM358,
  OPAMP_RAIL_TO_RAIL,
  OpAmp,
  Potentiometer,
  Resistor,
  VoltageSource,
} from '../src/index.js';

describe('MOSFET', () => {
  /** Low-side switch: load between the supply and the drain, source to ground. */
  function lowSideSwitch(gateVolts: number, model = MOSFET_IRLZ44N, loadOhms = 10) {
    const circuit = new Circuit();
    const [supply, drain, gate] = circuit.addNodes(3);
    circuit.add(new VoltageSource('VCC', supply!, GROUND, 12));
    circuit.add(new VoltageSource('VG', gate!, GROUND, gateVolts));
    circuit.add(new Resistor('RL', supply!, drain!, loadOhms));
    const q = circuit.add(new Mosfet('Q1', drain!, gate!, GROUND, 'n', model));
    circuit.solve();
    return { circuit, q, drain: drain! };
  }

  it('is off below its threshold', () => {
    const { q, circuit, drain } = lowSideSwitch(0);
    expect(q.region).toBe('cutoff');
    expect(Math.abs(q.drainCurrent)).toBeLessThan(1e-6);
    expect(circuit.voltage(drain)).toBeCloseTo(12, 3);
  });

  it('turns fully on with a logic-level gate drive', () => {
    // The reason to choose a logic-level part: 5 V from a pin is enough.
    const { q, circuit, drain } = lowSideSwitch(5);
    expect(q.region).toBe('linear');
    expect(circuit.voltage(drain)).toBeLessThan(0.5);
  });

  it('carries the current the load allows once on', () => {
    // 12 V across roughly 10 ohms.
    const { q } = lowSideSwitch(5, MOSFET_IRLZ44N, 10);
    expect(q.drainCurrent).toBeGreaterThan(1.1);
    expect(q.drainCurrent).toBeLessThan(1.25);
  });

  it('shows a non logic-level part failing on a 5 V gate', () => {
    // The mistake this simulator should be able to demonstrate: a 2N7000 in a place that needs a
    // logic-level device drops far more and dissipates far more than the datasheet's headline
    // RDS(on) suggests.
    const logic = lowSideSwitch(5, MOSFET_IRLZ44N, 10);
    const notLogic = lowSideSwitch(5, MOSFET_2N7000, 10);
    expect(notLogic.circuit.voltage(notLogic.drain)).toBeGreaterThan(
      logic.circuit.voltage(logic.drain),
    );
    expect(notLogic.q.dissipation).toBeGreaterThan(logic.q.dissipation);
  });

  it('reports dissipation, which decides whether it needs a heatsink', () => {
    const { q } = lowSideSwitch(5);
    expect(q.dissipation).toBeGreaterThan(0);
    expect(q.dissipation).toBeLessThan(2);
  });

  it('conducts more as the gate is driven harder', () => {
    const currents = [2, 2.5, 3, 4, 5].map((v) => lowSideSwitch(v, MOSFET_2N7000, 100).q.drainCurrent);
    for (let i = 1; i < currents.length; i++) {
      expect(currents[i]!).toBeGreaterThanOrEqual(currents[i - 1]!);
    }
  });

  it('switches an LED from a logic-level gate', () => {
    const circuit = new Circuit();
    const [supply, anode, drain, gate] = circuit.addNodes(4);
    circuit.add(new VoltageSource('VCC', supply!, GROUND, 5));
    const drive = circuit.add(new VoltageSource('VG', gate!, GROUND, 5));
    circuit.add(new Resistor('RL', supply!, anode!, 150));
    const led = circuit.add(new Led('D1', anode!, drain!, 'red'));
    circuit.add(new Mosfet('Q1', drain!, gate!, GROUND, 'n'));

    circuit.solve();
    expect(led.brightness).toBeGreaterThan(0.5);

    drive.volts = 0;
    circuit.solve();
    expect(led.brightness).toBeLessThan(0.05);
  });

  it('has a body diode that conducts when driven backwards', () => {
    // Physically part of the device, and what clamps the flyback from a coil.
    const circuit = new Circuit();
    const [drain] = circuit.addNodes(1);
    // Drain pulled below the source, which is what an inductive kick does.
    circuit.add(new VoltageSource('V', drain!, GROUND, -2));
    const q = circuit.add(new Mosfet('Q1', drain!, GROUND, GROUND, 'n'));
    circuit.solve();

    expect(Math.abs(q.bodyDiodeCurrent)).toBeGreaterThan(1e-3);
  });

  it('converges without a homotopy', () => {
    const circuit = new Circuit();
    const [supply, drain, gate] = circuit.addNodes(3);
    circuit.add(new VoltageSource('VCC', supply!, GROUND, 12));
    circuit.add(new VoltageSource('VG', gate!, GROUND, 5));
    circuit.add(new Resistor('RL', supply!, drain!, 10));
    circuit.add(new Mosfet('Q1', drain!, gate!, GROUND, 'n'));
    expect(circuit.solve().converged).toBe(true);
  });
});

describe('op-amp', () => {
  /** Non-inverting amplifier with the standard two-resistor feedback network. */
  function nonInverting(inputVolts: number, r1 = 10_000, r2 = 10_000, model = OPAMP_RAIL_TO_RAIL) {
    const circuit = new Circuit();
    const [rail, input, output, feedback] = circuit.addNodes(4);
    circuit.add(new VoltageSource('VCC', rail!, GROUND, 5));
    circuit.add(new VoltageSource('VIN', input!, GROUND, inputVolts));
    circuit.add(new Resistor('R1', feedback!, GROUND, r1));
    circuit.add(new Resistor('R2', output!, feedback!, r2));
    const amp = circuit.add(new OpAmp('U1', input!, feedback!, output!, rail!, GROUND, model));
    circuit.solve();
    return { circuit, amp, output: output! };
  }

  it('amplifies by 1 + R2/R1', () => {
    // The textbook result, and the one thing everybody checks.
    const { circuit, output } = nonInverting(1, 10_000, 10_000);
    expect(circuit.voltage(output)).toBeCloseTo(2, 1);
  });

  it('follows a different gain setting', () => {
    // 1 + 30k/10k = 4, so 1 V in should be 4 V out -- just inside a 5 V rail.
    const { circuit, output } = nonInverting(1, 10_000, 30_000);
    expect(circuit.voltage(output)).toBeGreaterThan(3.7);
    expect(circuit.voltage(output)).toBeLessThan(4.3);
  });

  it('holds the inputs at almost the same voltage while the loop is in control', () => {
    // The "virtual short" -- an effect of loop gain, not a rule, which is why it disappears the
    // moment the amplifier saturates.
    const { amp } = nonInverting(1);
    expect(Math.abs(amp.differentialInput)).toBeLessThan(0.001);
    expect(amp.saturated).toBe(false);
  });

  it('cannot exceed its own supply rail', () => {
    // An ideal linear model would output 8 V from a 5 V supply and every circuit built on it would
    // appear to work, including the ones that do not.
    const { circuit, output, amp } = nonInverting(4, 10_000, 10_000);
    expect(circuit.voltage(output)).toBeLessThanOrEqual(5.01);
    expect(amp.saturated).toBe(true);
  });

  it('loses the virtual short once saturated', () => {
    const { amp } = nonInverting(4, 10_000, 30_000);
    expect(amp.saturated).toBe(true);
    expect(Math.abs(amp.differentialInput)).toBeGreaterThan(0.01);
  });

  it('shows an LM358 falling short of its positive rail', () => {
    // The classic single-supply surprise: the same circuit that works with a rail-to-rail part
    // clips more than a volt early with an LM358.
    const lm358 = nonInverting(3, 10_000, 10_000, OPAMP_LM358);
    const railToRail = nonInverting(3, 10_000, 10_000, OPAMP_RAIL_TO_RAIL);
    expect(lm358.circuit.voltage(lm358.output)).toBeLessThan(
      railToRail.circuit.voltage(railToRail.output) - 1,
    );
  });

  it('works as a unity-gain buffer', () => {
    const circuit = new Circuit();
    const [rail, input, output] = circuit.addNodes(3);
    circuit.add(new VoltageSource('VCC', rail!, GROUND, 5));
    circuit.add(new VoltageSource('VIN', input!, GROUND, 2.5));
    circuit.add(new OpAmp('U1', input!, output!, output!, rail!, GROUND, OPAMP_RAIL_TO_RAIL));
    circuit.solve();
    expect(circuit.voltage(output!)).toBeCloseTo(2.5, 1);
  });

  it('works as a comparator, swinging fully one way or the other', () => {
    // Open loop: the output slams to a rail, which is what a comparator circuit relies on.
    for (const [inputVolts, expectHigh] of [[3, true], [1, false]] as const) {
      const circuit = new Circuit();
      const [rail, reference, input, output] = circuit.addNodes(4);
      circuit.add(new VoltageSource('VCC', rail!, GROUND, 5));
      circuit.add(new VoltageSource('VREF', reference!, GROUND, 2));
      circuit.add(new VoltageSource('VIN', input!, GROUND, inputVolts));
      circuit.add(new OpAmp('U1', input!, reference!, output!, rail!, GROUND, OPAMP_RAIL_TO_RAIL));
      circuit.solve();

      if (expectHigh) expect(circuit.voltage(output!)).toBeGreaterThan(4.5);
      else expect(circuit.voltage(output!)).toBeLessThan(0.5);
    }
  });

  it('converges across its whole input range', () => {
    for (const volts of [0, 0.5, 1, 2, 3, 4, 5]) {
      expect(nonInverting(volts).circuit.solve().converged).toBe(true);
    }
  });
});

describe('potentiometer', () => {
  /** Pot across a 5 V supply, wiper read at its tap. */
  function divider(position: number, taper: 'linear' | 'log' = 'linear') {
    const circuit = new Circuit();
    const [supply, wiper] = circuit.addNodes(2);
    circuit.add(new VoltageSource('VCC', supply!, GROUND, 5));
    const pot = circuit.add(new Potentiometer('POT', GROUND, wiper!, supply!, 10_000, position, taper));
    circuit.solve();
    return { circuit, pot, wiper: wiper! };
  }

  it('puts the wiper at the fraction of the supply the knob is turned to', () => {
    expect(divider(0.5).circuit.voltage(divider(0.5).wiper)).toBeCloseTo(2.5, 2);
  });

  it('sweeps the full range', () => {
    // Terminal A is ground and terminal B the supply, so position is the fraction turned "up".
    for (const [position, expected] of [[0, 0], [0.25, 1.25], [0.5, 2.5], [0.75, 3.75], [1, 5]] as const) {
      const { circuit, wiper } = divider(position);
      expect(circuit.voltage(wiper)).toBeCloseTo(expected, 1);
    }
  });

  it('gives the same fraction whatever its total resistance', () => {
    // The property that makes a pot a divider rather than a rheostat, and the reason a 10k and a
    // 100k pot behave identically in this circuit.
    for (const total of [1_000, 10_000, 100_000]) {
      const circuit = new Circuit();
      const [supply, wiper] = circuit.addNodes(2);
      circuit.add(new VoltageSource('VCC', supply!, GROUND, 5));
      circuit.add(new Potentiometer('POT', GROUND, wiper!, supply!, total, 0.5));
      circuit.solve();
      expect(circuit.voltage(wiper!)).toBeCloseTo(2.5, 2);
    }
  });

  it('splits its track between the two halves', () => {
    const { pot } = divider(0.3);
    expect(pot.resistanceA + pot.resistanceB).toBeCloseTo(10_000, 0);
    expect(pot.resistanceA).toBeCloseTo(3000, 0);
  });

  it('never presents a dead short at an extreme', () => {
    // A real track has end resistance, and a zero-ohm segment is numerically awkward besides.
    const { pot } = divider(0);
    expect(pot.resistanceA).toBeGreaterThan(0);
  });

  it('curves with an audio taper', () => {
    // A log pot at half travel sits well below half voltage, which is why volume controls feel
    // linear to the ear and wrong to a multimeter.
    const linear = divider(0.5, 'linear');
    const log = divider(0.5, 'log');
    expect(log.circuit.voltage(log.wiper)).toBeLessThan(linear.circuit.voltage(linear.wiper));
  });

  it('loads under a real load, as a divider does', () => {
    // The other half of the lesson: a pot is only a stiff divider while nothing much is drawn from
    // the wiper.
    const circuit = new Circuit();
    const [supply, wiper] = circuit.addNodes(2);
    circuit.add(new VoltageSource('VCC', supply!, GROUND, 5));
    circuit.add(new Potentiometer('POT', GROUND, wiper!, supply!, 100_000, 0.5));
    circuit.add(new Resistor('RLOAD', wiper!, GROUND, 1000));
    circuit.solve();

    // A 1k load on a 100k pot pulls the wiper far below half rail.
    expect(circuit.voltage(wiper!)).toBeLessThan(1);
  });

  it('rejects a non-positive resistance', () => {
    expect(() => new Potentiometer('P', 0, 1, 2, 0)).toThrow(RangeError);
  });
});
