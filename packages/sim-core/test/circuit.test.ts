/**
 * Newton-Raphson and the nonlinear device models.
 *
 * The M1 gate lives here: an LED driven through a series resistor must settle at a forward voltage
 * and current a datasheet would recognise, and driving it without a resistor must be detectable as
 * over-current rather than silently "working".
 */
import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/analog/circuit.js';
import { GROUND } from '../src/analog/mna.js';
import { Diode, Led, Resistor, Switch, VoltageSource, ledModel } from '../src/analog/devices.js';

describe('Circuit', () => {
  describe('linear circuits', () => {
    it('solves a divider in a single pass', () => {
      const circuit = new Circuit();
      const [supply, mid] = circuit.addNodes(2);
      circuit.add(new VoltageSource('V1', supply!, GROUND, 5));
      circuit.add(new Resistor('R1', supply!, mid!, 1000));
      circuit.add(new Resistor('R2', mid!, GROUND, 1000));

      const result = circuit.solve();
      expect(result.converged).toBe(true);
      expect(result.method).toBe('direct');
      expect(circuit.voltage(mid!)).toBeCloseTo(2.5, 6);
    });

    it('reports supply current through a resistive load', () => {
      const circuit = new Circuit();
      const [rail] = circuit.addNodes(1);
      const source = circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
      circuit.add(new Resistor('R1', rail!, GROUND, 1000));
      circuit.solve();

      expect(source.currentDelivered(circuit.system)).toBeCloseTo(0.005, 8);
    });

    it('models a switch as low and high resistance rather than an ideal short', () => {
      const circuit = new Circuit();
      const [rail, mid] = circuit.addNodes(2);
      circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
      circuit.add(new Resistor('R1', rail!, mid!, 10_000));
      const sw = circuit.add(new Switch('SW1', mid!, GROUND));

      circuit.solve();
      // Open: the 10k pulls the node essentially to the rail.
      expect(circuit.voltage(mid!)).toBeGreaterThan(4.9);

      sw.closed = true;
      circuit.solve();
      // Closed: 10 mOhm against 10k drags it to within a millivolt of ground.
      expect(circuit.voltage(mid!)).toBeLessThan(0.01);
    });
  });

  describe('LED through a series resistor -- the M1 gate', () => {
    /** 5 V -> R -> LED -> GND, the canonical beginner circuit. */
    function ledCircuit(ohms: number, color: 'red' | 'green' = 'red') {
      const circuit = new Circuit();
      const [rail, anode] = circuit.addNodes(2);
      const supply = circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
      const resistor = circuit.add(new Resistor('R1', rail!, anode!, ohms));
      const led = circuit.add(new Led('D1', anode!, GROUND, color));
      return { circuit, supply, resistor, led, anode: anode! };
    }

    it('converges on a red LED through 220R', () => {
      const { circuit, led } = ledCircuit(220);
      const result = circuit.solve();

      expect(result.converged).toBe(true);
      // Junction limiting alone should carry this; needing a homotopy would signal trouble.
      expect(result.method).toBe('direct');
      expect(result.iterations).toBeLessThan(30);
    });

    it('settles at a forward voltage and current a datasheet would recognise', () => {
      const { circuit, led } = ledCircuit(220);
      circuit.solve();

      // A 2.0 V-at-20 mA red LED run at ~14 mA sits a little below its rated Vf.
      expect(led.forwardVoltage).toBeGreaterThan(1.8);
      expect(led.forwardVoltage).toBeLessThan(2.0);
      expect(led.current).toBeGreaterThan(0.012);
      expect(led.current).toBeLessThan(0.016);
    });

    it('closes KVL around the loop', () => {
      // The strongest check available: supply = resistor drop + LED drop, to within a microvolt.
      const { circuit, resistor, led, anode } = ledCircuit(220);
      circuit.solve();

      const resistorDrop = 5 - circuit.voltage(anode);
      expect(resistorDrop + led.forwardVoltage).toBeCloseTo(5, 6);
      // And the same current must flow through both, since they are in series.
      expect(resistorDrop / 220).toBeCloseTo(led.current, 9);
    });

    it('gives a green LED a higher forward voltage and less current', () => {
      const { circuit: red, led: redLed } = ledCircuit(220, 'red');
      const { circuit: green, led: greenLed } = ledCircuit(220, 'green');
      red.solve();
      green.solve();

      expect(greenLed.forwardVoltage).toBeGreaterThan(redLed.forwardVoltage + 0.8);
      expect(greenLed.current).toBeLessThan(redLed.current);
      // ~3.1 V at ~8.8 mA: a real InGaN green part.
      expect(greenLed.forwardVoltage).toBeGreaterThan(2.9);
      expect(greenLed.forwardVoltage).toBeLessThan(3.2);
    });

    it('draws more current through a smaller resistor', () => {
      const currents = [1000, 470, 220, 100].map((ohms) => {
        const { circuit, led } = ledCircuit(ohms);
        circuit.solve();
        return led.current;
      });

      for (let i = 1; i < currents.length; i++) {
        expect(currents[i]!).toBeGreaterThan(currents[i - 1]!);
      }
    });

    it('flags over-current when the series resistor is missing', () => {
      // This is the fault the whole project exists to catch. Wired straight to a 5 V rail through
      // only its own bulk resistance, a red LED pulls far past its 30 mA absolute maximum.
      const { circuit, led } = ledCircuit(0.001);
      circuit.solve();

      expect(led.overCurrent).toBe(true);
      expect(led.current).toBeGreaterThan(0.1);
    });

    it('does not flag over-current at a sane operating point', () => {
      const { circuit, led } = ledCircuit(220);
      circuit.solve();
      expect(led.overCurrent).toBe(false);
    });

    it('reports brightness that tracks current', () => {
      const dim = ledCircuit(2200);
      const bright = ledCircuit(220);
      dim.circuit.solve();
      bright.circuit.solve();

      expect(dim.led.brightness).toBeGreaterThan(0);
      expect(dim.led.brightness).toBeLessThan(bright.led.brightness);
      expect(bright.led.brightness).toBeLessThanOrEqual(1);
    });

    it('leaves the LED dark and drawing nothing when reverse-biased', () => {
      const circuit = new Circuit();
      const [rail, cathode] = circuit.addNodes(2);
      circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
      circuit.add(new Resistor('R1', rail!, cathode!, 220));
      // Backwards: anode at ground, cathode at the rail.
      const led = circuit.add(new Led('D1', GROUND, cathode!, 'red'));
      circuit.solve();

      expect(led.brightness).toBe(0);
      expect(Math.abs(led.current)).toBeLessThan(1e-6);
    });
  });

  describe('diode models', () => {
    it('gives a silicon diode a ~0.7 V drop at milliamp currents', () => {
      const circuit = new Circuit();
      const [rail, anode] = circuit.addNodes(2);
      circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
      circuit.add(new Resistor('R1', rail!, anode!, 1000));
      const diode = circuit.add(new Diode('D1', anode!, GROUND));
      circuit.solve();

      expect(diode.forwardVoltage).toBeGreaterThan(0.6);
      expect(diode.forwardVoltage).toBeLessThan(0.85);
      expect(diode.current).toBeCloseTo((5 - diode.forwardVoltage) / 1000, 6);
    });

    it('blocks in reverse', () => {
      const circuit = new Circuit();
      const [rail, cathode] = circuit.addNodes(2);
      circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
      circuit.add(new Resistor('R1', rail!, cathode!, 1000));
      const diode = circuit.add(new Diode('D1', GROUND, cathode!));
      circuit.solve();

      // Only saturation-scale leakage flows.
      expect(Math.abs(diode.current)).toBeLessThan(1e-6);
    });

    it('derives LED models that pass through their datasheet point', () => {
      // 20 mA is where every LED datasheet quotes Vf, so that is the point the model must honour.
      for (const [color, vf] of [['red', 2.0], ['green', 3.2]] as const) {
        const circuit = new Circuit();
        const [anode] = circuit.addNodes(1);
        // Drive exactly 20 mA and read back the forward voltage.
        circuit.add(new VoltageSource('V1', anode!, GROUND, vf));
        const led = circuit.add(new Led('D1', anode!, GROUND, color));
        circuit.solve();
        expect(led.current).toBeCloseTo(0.02, 3);
      }
    });

    it('exposes model parameters derived from colour', () => {
      expect(ledModel('red').saturationCurrent).toBeGreaterThan(ledModel('blue').saturationCurrent);
      expect(ledModel('green').emissionCoefficient).toBe(2);
    });
  });

  describe('convergence', () => {
    it('converges with many diodes in series', () => {
      // Six junctions in a chain: each one compounds the exponential, and this is where a solver
      // without junction limiting reliably blows up.
      const circuit = new Circuit();
      const nodes = circuit.addNodes(8);
      circuit.add(new VoltageSource('V1', nodes[0]!, GROUND, 12));
      circuit.add(new Resistor('R1', nodes[0]!, nodes[1]!, 470));
      for (let i = 1; i <= 6; i++) {
        circuit.add(new Diode(`D${i}`, nodes[i]!, i === 6 ? GROUND : nodes[i + 1]!));
      }

      const result = circuit.solve();
      expect(result.converged).toBe(true);
    });

    it('converges on a chain of LEDs', () => {
      const circuit = new Circuit();
      const nodes = circuit.addNodes(4);
      circuit.add(new VoltageSource('V1', nodes[0]!, GROUND, 12));
      circuit.add(new Resistor('R1', nodes[0]!, nodes[1]!, 330));
      circuit.add(new Led('D1', nodes[1]!, nodes[2]!, 'red'));
      circuit.add(new Led('D2', nodes[2]!, nodes[3]!, 'red'));
      circuit.add(new Led('D3', nodes[3]!, GROUND, 'red'));

      expect(circuit.solve().converged).toBe(true);
    });

    it('solves a completely floating subcircuit without throwing', () => {
      // A part dropped on the canvas and not yet wired. gmin is what keeps this solvable.
      const circuit = new Circuit();
      const [a, b] = circuit.addNodes(2);
      circuit.add(new Resistor('R1', a!, b!, 1000));
      expect(() => circuit.solve()).not.toThrow();
    });

    it('is repeatable', () => {
      const build = () => {
        const circuit = new Circuit();
        const [rail, anode] = circuit.addNodes(2);
        circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
        circuit.add(new Resistor('R1', rail!, anode!, 220));
        const led = circuit.add(new Led('D1', anode!, GROUND, 'red'));
        circuit.solve();
        return led.current;
      };
      expect(build()).toBe(build());
    });

    it('re-solves correctly after a source value changes', () => {
      const circuit = new Circuit();
      const [rail, anode] = circuit.addNodes(2);
      const supply = circuit.add(new VoltageSource('V1', rail!, GROUND, 5));
      circuit.add(new Resistor('R1', rail!, anode!, 220));
      const led = circuit.add(new Led('D1', anode!, GROUND, 'red'));

      circuit.solve();
      const at5v = led.current;

      supply.volts = 3.3;
      circuit.solve();
      const at3v3 = led.current;

      expect(at3v3).toBeLessThan(at5v);
      expect(at3v3).toBeGreaterThan(0);

      supply.volts = 0;
      circuit.solve();
      expect(led.current).toBeLessThan(1e-6);
    });
  });
});
