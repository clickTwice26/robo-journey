/**
 * Meters.
 *
 * The thing being tested is not that a meter reports a number -- reading a node voltage out of the
 * solver would do that. It is that the meter is in the circuit: that ten megohms across a
 * high-impedance divider moves the reading, that a shunt in series costs a real voltage, and that
 * the current jacks across a supply destroy the meter rather than reporting a large number.
 */
import { describe, expect, it } from 'vitest';
import { Circuit } from '../src/analog/circuit.js';
import { GROUND } from '../src/analog/mna.js';
import { Resistor, VoltageSource } from '../src/analog/devices.js';
import { Ammeter, Multimeter, ScopeChannel, formatReading } from '../src/instruments/meters.js';

/** A divider from a 9 V supply, with the meter across the lower leg. */
function divider(upperOhms: number, lowerOhms: number) {
  const circuit = new Circuit();
  const supply = circuit.addNode();
  const mid = circuit.addNode();
  circuit.add(new VoltageSource('V1', supply, GROUND, 9));
  circuit.add(new Resistor('R1', supply, mid, upperOhms));
  circuit.add(new Resistor('R2', mid, GROUND, lowerOhms));
  return { circuit, supply, mid };
}

describe('a voltmeter', () => {
  it('reads a divider it does not disturb', () => {
    // 1k over 1k from 9 V is 4.5 V, and ten megohms alongside a kilohm changes nothing anyone
    // could measure.
    const { circuit, mid } = divider(1000, 1000);
    const meter = new Multimeter('M1', mid, GROUND, circuit.addNode(), { mode: 'volts' });
    circuit.add(meter);
    circuit.step(1e-6);

    expect(meter.reading).toBeCloseTo(4.5, 3);
  });

  it('disturbs a divider it cannot help disturbing', () => {
    // 1M over 1M should also be 4.5 V. Ten megohms across the lower leg makes it 909k, and the
    // meter reads 4.29 V -- lower than the truth, because the probe is now part of the divider.
    // This is the single most useful thing a simulated voltmeter can teach, and a simulator that
    // read the node directly would show 4.5 V and teach nothing.
    const { circuit, mid } = divider(1e6, 1e6);
    const meter = new Multimeter('M1', mid, GROUND, circuit.addNode(), { mode: 'volts' });
    circuit.add(meter);
    circuit.step(1e-6);

    expect(meter.reading).toBeLessThan(4.4);
    expect(meter.reading).toBeCloseTo(4.29, 1);
  });

  it('reads the difference between its probes, not a voltage to ground', () => {
    const { circuit, supply, mid } = divider(1000, 1000);
    const meter = new Multimeter('M1', supply, mid, circuit.addNode(), { mode: 'volts' });
    circuit.add(meter);
    circuit.step(1e-6);

    expect(meter.reading).toBeCloseTo(4.5, 2);
  });
});

describe('an ammeter', () => {
  it('reads the current through a series circuit', () => {
    // 9 V across 1k is 9 mA, less the ohm of shunt the meter adds.
    const circuit = new Circuit();
    const supply = circuit.addNode();
    const mid = circuit.addNode();
    circuit.add(new VoltageSource('V1', supply, GROUND, 9));
    circuit.add(new Resistor('R1', supply, mid, 1000));
    const meter = new Ammeter('A1', mid, GROUND);
    circuit.add(meter);
    circuit.step(1e-6);

    expect(meter.amps).toBeCloseTo(9 / 1001, 5);
  });

  it('costs the circuit a real voltage to measure it', () => {
    // Burden voltage: the reason a marginal circuit sometimes stops working the moment you put a
    // current meter in it.
    const circuit = new Circuit();
    const supply = circuit.addNode();
    const mid = circuit.addNode();
    circuit.add(new VoltageSource('V1', supply, GROUND, 5));
    circuit.add(new Resistor('R1', supply, mid, 50));
    const meter = new Ammeter('A1', mid, GROUND);
    circuit.add(meter);
    circuit.step(1e-6);

    expect(meter.burdenVolts).toBeGreaterThan(0.05);
    expect(meter.burdenVolts).toBeCloseTo(meter.amps * 1, 6);
  });

  it('blows its fuse across a supply, and stays blown', () => {
    // The commonest way a multimeter dies: current jacks straight across the rail.
    const circuit = new Circuit();
    const supply = circuit.addNode();
    circuit.add(new VoltageSource('V1', supply, GROUND, 5));
    const meter = new Ammeter('A1', supply, GROUND, { range: 'mA' });
    circuit.add(meter);

    circuit.step(1e-6);
    expect(meter.blown).toBe(true);

    // Once blown it is an open circuit and reads nothing, however long you look at it.
    circuit.step(1e-6);
    expect(meter.amps).toBe(0);
    expect(meter.readout()[0]!.value).toBe('FUSE');
  });

  it('takes a current on the amp range that would blow the milliamp fuse', () => {
    // Half an amp through a motor: over the 200 mA milliamp fuse, well inside the 10 A one. Moving
    // the lead to the other jack is the whole difference, and it is the decision people get wrong.
    const build = (range: 'mA' | 'A') => {
      const circuit = new Circuit();
      const supply = circuit.addNode();
      const mid = circuit.addNode();
      circuit.add(new VoltageSource('V1', supply, GROUND, 5));
      circuit.add(new Resistor('R1', supply, mid, 10));
      const meter = new Ammeter('A1', mid, GROUND, { range });
      circuit.add(meter);
      circuit.step(1e-6);
      return meter;
    };

    expect(build('mA').blown).toBe(true);

    const survivor = build('A');
    expect(survivor.blown).toBe(false);
    expect(survivor.amps).toBeCloseTo(0.5, 2);
  });
});

describe('an ohmmeter', () => {
  it('measures a resistor with nothing else connected', () => {
    const circuit = new Circuit();
    const a = circuit.addNode();
    circuit.add(new Resistor('R1', a, GROUND, 4700));
    const meter = new Multimeter('M1', a, GROUND, circuit.addNode(), { mode: 'ohms' });
    circuit.add(meter);
    circuit.step(1e-6);

    // The 10 M input sits across the unknown, so 4k7 measures a hair low. A real meter does the
    // same and nobody notices, which is the point of matching it rather than idealising it.
    expect(meter.reading).toBeCloseTo(4700, -1);
  });

  it('shows an open circuit as over-range', () => {
    const circuit = new Circuit();
    const a = circuit.addNode();
    const meter = new Multimeter('M1', a, GROUND, circuit.addNode(), { mode: 'ohms' });
    circuit.add(meter);
    circuit.step(1e-6);

    expect(meter.display()).toBe('OL');
  });

  it('refuses to guess at a live circuit', () => {
    // Measuring resistance in a powered circuit gives a number that means nothing. Every manual
    // says to power down first; this says why.
    const circuit = new Circuit();
    const supply = circuit.addNode();
    circuit.add(new VoltageSource('V1', supply, GROUND, 5));
    const meter = new Multimeter('M1', supply, GROUND, circuit.addNode(), { mode: 'ohms' });
    circuit.add(meter);
    circuit.step(1e-6);

    expect(meter.display()).toBe('LIVE');
    expect(meter.readout().some((r) => r.value.includes('power the circuit down'))).toBe(true);
  });
});

describe('a scope channel', () => {
  it('measures its tip against its own ground clip', () => {
    const { circuit, supply, mid } = divider(1000, 1000);
    const channel = new ScopeChannel('S1:CH1', supply, mid);
    circuit.add(channel);
    circuit.step(1e-6);

    expect(channel.volts).toBeCloseTo(4.5, 2);
  });

  it('loads the circuit by a megohm, as a real probe does', () => {
    const { circuit, mid } = divider(1e6, 1e6);
    circuit.add(new ScopeChannel('S1:CH1', mid, GROUND));
    circuit.step(1e-6);

    // A megohm across the lower leg of a 1M/1M divider pulls 4.5 V down to 3 V. Probe loading is
    // real and this is the circuit where it bites.
    expect(circuit.voltage(mid)).toBeCloseTo(3, 1);
  });
});

describe('the display', () => {
  it('autoranges the way a four-digit meter does', () => {
    expect(formatReading(4.982, 'V')).toBe('4.982 V');
    expect(formatReading(0.0124, 'A')).toBe('12.40 mA');
    expect(formatReading(4700, 'R')).toBe('4.700 kR');
    expect(formatReading(0.000_002_5, 'A')).toBe('2.500 uA');
    expect(formatReading(123.456, 'V')).toBe('123.5 V');
  });

  it('shows a true zero rather than a fake precision', () => {
    expect(formatReading(0, 'V')).toBe('0.000 V');
  });
});
