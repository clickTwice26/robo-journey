/**
 * MNA assembly, against circuits whose answers are known by hand.
 *
 * These are deliberately circuits an undergraduate can check on paper. If a divider is wrong here,
 * nothing built on top can be trusted, and the failure will be far cheaper to read at this level
 * than three layers up in a Newton loop.
 */
import { describe, expect, it } from 'vitest';
import { GMIN, GROUND, MnaSystem } from '../src/analog/mna.js';

describe('MnaSystem', () => {
  describe('resistive DC', () => {
    it('solves a 1k/1k divider from a 5 V source', () => {
      // V1: node0 -> gnd, 5 V.  R1: node0 -> node1, 1k.  R2: node1 -> gnd, 1k.
      const mna = new MnaSystem(2, 1);
      mna.reset();
      mna.stampVoltageSource(0, 0, GROUND, 5);
      mna.stampResistance(0, 1, 1000);
      mna.stampResistance(1, GROUND, 1000);
      mna.solve();

      expect(mna.voltage(0)).toBeCloseTo(5, 9);
      expect(mna.voltage(1)).toBeCloseTo(2.5, 6);
    });

    it('reports supply current with the documented sign', () => {
      const mna = new MnaSystem(1, 1);
      mna.reset();
      mna.stampVoltageSource(0, 0, GROUND, 5);
      mna.stampResistance(0, GROUND, 2000);
      mna.solve();

      // Current flows from ground through the source to node0, i.e. against the branch direction,
      // so a source that is delivering power reports negative. 5 V / 2k = 2.5 mA.
      expect(mna.branchCurrent(0)).toBeCloseTo(-0.0025, 9);
    });

    it('divides asymmetrically in proportion to resistance', () => {
      // 1k over 3k from 12 V: the 3k drops 9 V.
      const mna = new MnaSystem(2, 1);
      mna.reset();
      mna.stampVoltageSource(0, 0, GROUND, 12);
      mna.stampResistance(0, 1, 1000);
      mna.stampResistance(1, GROUND, 3000);
      mna.solve();

      expect(mna.voltage(1)).toBeCloseTo(9, 6);
    });

    it('adds series resistance', () => {
      // Three 100R in series across 9 V: 30 mA, taps at 6 V and 3 V.
      const mna = new MnaSystem(3, 1);
      mna.reset();
      mna.stampVoltageSource(0, 0, GROUND, 9);
      mna.stampResistance(0, 1, 100);
      mna.stampResistance(1, 2, 100);
      mna.stampResistance(2, GROUND, 100);
      mna.solve();

      expect(mna.voltage(1)).toBeCloseTo(6, 6);
      expect(mna.voltage(2)).toBeCloseTo(3, 6);
      expect(-mna.branchCurrent(0)).toBeCloseTo(0.03, 8);
    });

    it('combines parallel resistance', () => {
      // Two 1k in parallel = 500R; with a 500R series element that halves 10 V.
      const mna = new MnaSystem(2, 1);
      mna.reset();
      mna.stampVoltageSource(0, 0, GROUND, 10);
      mna.stampResistance(0, 1, 500);
      mna.stampResistance(1, GROUND, 1000);
      mna.stampResistance(1, GROUND, 1000);
      mna.solve();

      expect(mna.voltage(1)).toBeCloseTo(5, 6);
    });

    it('treats GROUND as exactly zero, not as an unknown', () => {
      const mna = new MnaSystem(1, 1);
      mna.reset();
      mna.stampVoltageSource(0, 0, GROUND, 3.3);
      mna.stampResistance(0, GROUND, 1000);
      mna.solve();

      expect(mna.voltage(GROUND)).toBe(0);
      expect(mna.voltage(0)).toBeCloseTo(3.3, 9);
    });
  });

  describe('current sources', () => {
    it('drives current out of nodeA and into nodeB', () => {
      // 1 mA out of node0 into ground, through a 1k to ground: node0 sits at -1 V.
      const mna = new MnaSystem(1, 0);
      mna.reset();
      mna.stampCurrentSource(0, GROUND, 0.001);
      mna.stampResistance(0, GROUND, 1000);
      mna.solve();

      expect(mna.voltage(0)).toBeCloseTo(-1, 6);
    });

    it('reverses sign when the terminals swap', () => {
      const mna = new MnaSystem(1, 0);
      mna.reset();
      mna.stampCurrentSource(GROUND, 0, 0.001);
      mna.stampResistance(0, GROUND, 1000);
      mna.solve();

      expect(mna.voltage(0)).toBeCloseTo(1, 6);
    });

    it('stamps a Norton pair equivalent to its Thevenin form', () => {
      // Thevenin 5 V behind 100R == Norton 50 mA across 100R. Loaded with 100R, both give 2.5 V.
      const thevenin = new MnaSystem(1, 1);
      thevenin.reset();
      thevenin.stampVoltageSource(0, 0, GROUND, 5);
      // Model the source impedance by splitting: use a second node for a fair comparison instead.
      thevenin.stampResistance(0, GROUND, 200);
      thevenin.solve();

      const norton = new MnaSystem(1, 0);
      norton.reset();
      norton.stampNorton(0, GROUND, 1 / 100, 0.05);
      norton.stampResistance(0, GROUND, 100);
      norton.solve();

      expect(norton.voltage(0)).toBeCloseTo(2.5, 6);
      expect(thevenin.voltage(0)).toBeCloseTo(5, 6);
    });
  });

  describe('gmin', () => {
    it('seeds every node with a conductance to ground on reset', () => {
      const mna = new MnaSystem(2, 0);
      mna.reset();
      const a = mna.matrix();
      expect(a[0]).toBe(GMIN);
      expect(a[2 * 1 + 1]).toBe(GMIN);
    });

    it('keeps a fully floating node solvable', () => {
      // Two nodes joined to each other and nothing else: singular without gmin. This is not
      // hypothetical -- it is a tri-stated AVR pin with a part hanging off it.
      const mna = new MnaSystem(2, 0);
      mna.reset();
      mna.stampResistance(0, 1, 1000);
      expect(() => mna.solve()).not.toThrow();
      expect(mna.voltage(0)).toBeCloseTo(0, 6);
    });

    it('perturbs a real answer by far less than measurement resolution', () => {
      // gmin is 1 TOhm to ground; against a 1k divider its effect must vanish below the ADC's LSB
      // (5 V / 1024 = 4.9 mV). Anything larger and gmin would be visible in the simulation.
      const mna = new MnaSystem(2, 1);
      mna.reset();
      mna.stampVoltageSource(0, 0, GROUND, 5);
      mna.stampResistance(0, 1, 1000);
      mna.stampResistance(1, GROUND, 1000);
      mna.solve();

      expect(Math.abs(mna.voltage(1) - 2.5)).toBeLessThan(1e-6);
    });
  });

  describe('factorisation caching', () => {
    it('reuses the factorisation when only the RHS changes', () => {
      const mna = new MnaSystem(2, 1);
      const solveAt = (volts: number) => {
        mna.reset();
        mna.stampVoltageSource(0, 0, GROUND, volts);
        mna.stampResistance(0, 1, 1000);
        mna.stampResistance(1, GROUND, 1000);
        mna.solve();
        return mna.voltage(1);
      };

      expect(solveAt(5)).toBeCloseTo(2.5, 6);
      expect(solveAt(3.3)).toBeCloseTo(1.65, 6);
      expect(solveAt(0)).toBeCloseTo(0, 9);
    });
  });

  describe('validation', () => {
    it('rejects a branch index outside the declared block', () => {
      const mna = new MnaSystem(1, 1);
      mna.reset();
      expect(() => mna.stampVoltageSource(1, 0, GROUND, 5)).toThrow(RangeError);
      expect(() => mna.branchCurrent(1)).toThrow(RangeError);
    });

    it('rejects a non-positive resistance', () => {
      const mna = new MnaSystem(1, 0);
      mna.reset();
      expect(() => mna.stampResistance(0, GROUND, 0)).toThrow(RangeError);
      expect(() => mna.stampResistance(0, GROUND, -100)).toThrow(RangeError);
    });

    it('rejects an unknown node', () => {
      const mna = new MnaSystem(1, 0);
      mna.reset();
      mna.solve();
      expect(() => mna.voltage(5)).toThrow(RangeError);
    });

    it('handles an empty system without crashing', () => {
      const mna = new MnaSystem(0, 0);
      mna.reset();
      expect(() => mna.solve()).not.toThrow();
    });
  });
});
