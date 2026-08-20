/**
 * Bipolar junction transistors.
 *
 * The assertions are the numbers an engineer checks on a bench: about 0.7 V across a conducting
 * base-emitter junction, a collector current near beta times the base current in the active
 * region, and a saturated switch pulling its collector down to a couple of hundred millivolts.
 * Anything that reproduces those is usable for the thing people actually build transistors into.
 */
import { describe, expect, it } from 'vitest';
import { BJT_BC547, Bjt, Circuit, GROUND, Led, Resistor, VoltageSource } from '../src/index.js';

/**
 * Common-emitter stage: 5 V supply, base resistor, collector resistor, emitter grounded.
 *
 * The circuit every transistor tutorial starts with, and the one people wire when they want an
 * Arduino pin to switch something it cannot drive directly.
 */
function commonEmitter(options: {
  baseVolts: number;
  baseOhms?: number;
  collectorOhms?: number;
  supplyVolts?: number;
}) {
  const circuit = new Circuit();
  const [supply, collector, baseDrive, base] = circuit.addNodes(4);

  circuit.add(new VoltageSource('VCC', supply!, GROUND, options.supplyVolts ?? 5));
  circuit.add(new VoltageSource('VIN', baseDrive!, GROUND, options.baseVolts));
  circuit.add(new Resistor('RB', baseDrive!, base!, options.baseOhms ?? 10_000));
  circuit.add(new Resistor('RC', supply!, collector!, options.collectorOhms ?? 1000));
  const q = circuit.add(new Bjt('Q1', collector!, base!, GROUND, 'npn'));

  circuit.solve();
  return { circuit, q, collector: collector!, base: base! };
}

describe('NPN transistor', () => {
  describe('cut off', () => {
    it('passes essentially nothing with the base at ground', () => {
      const { q } = commonEmitter({ baseVolts: 0 });
      expect(q.region).toBe('cutoff');
      expect(Math.abs(q.collectorCurrent)).toBeLessThan(1e-6);
    });

    it('leaves the collector at the supply rail', () => {
      const { circuit, collector } = commonEmitter({ baseVolts: 0 });
      expect(circuit.voltage(collector)).toBeCloseTo(5, 3);
    });
  });

  describe('conducting', () => {
    it('drops about 0.7 V across the base-emitter junction', () => {
      // The single number everyone checks first.
      const { q } = commonEmitter({ baseVolts: 5 });
      expect(q.vbe).toBeGreaterThan(0.6);
      expect(q.vbe).toBeLessThan(0.85);
    });

    it('draws base current set by the base resistor and Vbe', () => {
      // (5 - 0.7) / 10k = 430 uA.
      const { q } = commonEmitter({ baseVolts: 5, baseOhms: 10_000 });
      expect(q.baseCurrent).toBeGreaterThan(3e-4);
      expect(q.baseCurrent).toBeLessThan(5e-4);
    });

    it('saturates when the base is driven hard', () => {
      // 430 uA of base current times a beta of 290 would be 125 mA, but a 1k collector resistor
      // on 5 V can only deliver 5 mA -- so the transistor bottoms out. That is what a switch does,
      // and the reverse transport term is what makes it happen.
      const { q, circuit, collector } = commonEmitter({ baseVolts: 5 });
      expect(q.region).toBe('saturation');
      expect(circuit.voltage(collector)).toBeLessThan(0.3);
    });

    it('reaches a collector current the supply and load allow', () => {
      const { q } = commonEmitter({ baseVolts: 5, collectorOhms: 1000 });
      // (5 - Vce_sat) / 1k, a shade under 5 mA.
      expect(q.collectorCurrent).toBeGreaterThan(0.0045);
      expect(q.collectorCurrent).toBeLessThan(0.0052);
    });
  });

  describe('active region', () => {
    it('amplifies: collector current tracks base current times beta', () => {
      // A large collector resistor would saturate it, so use a small one and a weak base drive to
      // keep the device in its linear region, where the gain is the point.
      const { q } = commonEmitter({ baseVolts: 5, baseOhms: 2_000_000, collectorOhms: 1000 });
      expect(q.region).toBe('active');

      const gain = q.collectorCurrent / q.baseCurrent;
      // Within a factor of two of the model's hFE, which is all a real part guarantees.
      expect(gain).toBeGreaterThan(BJT_BC547.forwardBeta * 0.5);
      expect(gain).toBeLessThan(BJT_BC547.forwardBeta * 1.5);
    });

    it('increases collector current as base drive increases', () => {
      const currents = [1.0, 2.0, 3.0, 5.0].map(
        (volts) => commonEmitter({ baseVolts: volts, baseOhms: 1_000_000 }).q.collectorCurrent,
      );
      for (let i = 1; i < currents.length; i++) {
        expect(currents[i]!).toBeGreaterThan(currents[i - 1]!);
      }
    });
  });

  describe('as a switch driving a load', () => {
    it('lights an LED the base current alone could never drive', () => {
      // The reason to reach for a transistor: a microcontroller pin sourcing half a milliamp
      // switching twenty through the LED.
      const circuit = new Circuit();
      const [supply, anode, collector, drive, base] = circuit.addNodes(5);

      circuit.add(new VoltageSource('VCC', supply!, GROUND, 5));
      circuit.add(new VoltageSource('VIN', drive!, GROUND, 5));
      circuit.add(new Resistor('RB', drive!, base!, 10_000));
      circuit.add(new Resistor('RL', supply!, anode!, 150));
      const led = circuit.add(new Led('D1', anode!, collector!, 'red'));
      const q = circuit.add(new Bjt('Q1', collector!, base!, GROUND, 'npn'));
      circuit.solve();

      expect(led.current).toBeGreaterThan(0.015);
      expect(q.baseCurrent).toBeLessThan(0.001);
      // The whole point: far more current through the load than into the base.
      expect(led.current / q.baseCurrent).toBeGreaterThan(20);
    });

    it('turns the load off when the drive goes low', () => {
      const circuit = new Circuit();
      const [supply, anode, collector, drive, base] = circuit.addNodes(5);
      circuit.add(new VoltageSource('VCC', supply!, GROUND, 5));
      const input = circuit.add(new VoltageSource('VIN', drive!, GROUND, 5));
      circuit.add(new Resistor('RB', drive!, base!, 10_000));
      circuit.add(new Resistor('RL', supply!, anode!, 150));
      const led = circuit.add(new Led('D1', anode!, collector!, 'red'));
      circuit.add(new Bjt('Q1', collector!, base!, GROUND, 'npn'));

      circuit.solve();
      expect(led.brightness).toBeGreaterThan(0.5);

      input.volts = 0;
      circuit.solve();
      expect(led.brightness).toBeLessThan(0.05);
    });
  });

  describe('PNP', () => {
    it('is the same device with every polarity inverted', () => {
      // Emitter to the positive rail, base pulled down to turn it on.
      const circuit = new Circuit();
      const [supply, collector, drive, base] = circuit.addNodes(4);
      circuit.add(new VoltageSource('VCC', supply!, GROUND, 5));
      circuit.add(new VoltageSource('VIN', drive!, GROUND, 0));
      circuit.add(new Resistor('RB', drive!, base!, 10_000));
      circuit.add(new Resistor('RC', collector!, GROUND, 1000));
      const q = circuit.add(new Bjt('Q1', collector!, base!, supply!, 'pnp'));
      circuit.solve();

      // Conducting, with the sign conventions reported the same way round as for an NPN.
      expect(q.vbe).toBeLessThan(-0.6);
      expect(q.collectorCurrent).toBeLessThan(-0.004);
      expect(circuit.voltage(collector!)).toBeGreaterThan(4.5);
    });

    it('is off with the base at the emitter rail', () => {
      const circuit = new Circuit();
      const [supply, collector, base] = circuit.addNodes(3);
      circuit.add(new VoltageSource('VCC', supply!, GROUND, 5));
      circuit.add(new Resistor('RB', supply!, base!, 10_000));
      circuit.add(new Resistor('RC', collector!, GROUND, 1000));
      const q = circuit.add(new Bjt('Q1', collector!, base!, supply!, 'pnp'));
      circuit.solve();

      expect(q.region).toBe('cutoff');
      expect(circuit.voltage(collector!)).toBeLessThan(0.01);
    });
  });

  describe('convergence', () => {
    it('converges without needing a homotopy', () => {
      // Junction limiting on both junctions should carry an ordinary stage; reaching for gmin
      // stepping here would mean the damping is not working.
      const circuit = new Circuit();
      const [supply, collector, drive, base] = circuit.addNodes(4);
      circuit.add(new VoltageSource('VCC', supply!, GROUND, 5));
      circuit.add(new VoltageSource('VIN', drive!, GROUND, 5));
      circuit.add(new Resistor('RB', drive!, base!, 10_000));
      circuit.add(new Resistor('RC', supply!, collector!, 1000));
      circuit.add(new Bjt('Q1', collector!, base!, GROUND, 'npn'));

      const result = circuit.solve();
      expect(result.converged).toBe(true);
      expect(result.method).toBe('direct');
    });

    it('converges with transistors in a Darlington pair', () => {
      // Two devices in cascade multiply the exponentials, which is where an undamped solver dies.
      const circuit = new Circuit();
      const [supply, collector, drive, base, mid] = circuit.addNodes(5);
      circuit.add(new VoltageSource('VCC', supply!, GROUND, 5));
      circuit.add(new VoltageSource('VIN', drive!, GROUND, 3));
      circuit.add(new Resistor('RB', drive!, base!, 100_000));
      circuit.add(new Resistor('RC', supply!, collector!, 470));
      circuit.add(new Bjt('Q1', collector!, base!, mid!, 'npn'));
      circuit.add(new Bjt('Q2', collector!, mid!, GROUND, 'npn'));

      expect(circuit.solve().converged).toBe(true);
    });

    it('is repeatable', () => {
      const run = () => commonEmitter({ baseVolts: 5 }).q.collectorCurrent;
      expect(run()).toBe(run());
    });
  });
});
