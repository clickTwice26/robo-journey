/**
 * Building Blink on a breadboard.
 *
 * This is the M2 gate expressed without a UI: the same project the canvas will produce, run
 * through the same builder, asserting the LED lights. Everything the mouse does is create parts
 * and wires, so if this passes the visual layer is presentation rather than logic.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Led, loadHex } from '@robo-journey/sim-core';
import { buildCircuit, parseProject, type Project } from '../src/index.js';

const blinkHex = readFileSync(
  fileURLToPath(new URL('../../sim-core/test/fixtures/blink.hex', import.meta.url)),
  'utf8',
);

/**
 * D13 -> jumper -> column 5 -> 220R -> column 9 -> LED -> column 10 -> jumper -> GND.
 *
 * Note the resistor spans columns 5 to 9: through-hole resistors are bent to a 0.4" span, which is
 * four holes. The LED spans 9 to 10, a single 0.1" pitch. These are the real geometries.
 */
function blinkOnBreadboard(overrides: Partial<Project> = {}): Project {
  return parseProject({
    version: 1,
    name: 'Blink',
    parts: [
      { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
      { id: 'bb1', type: 'breadboard-half', x: 0, y: 70 },
      { id: 'r1', type: 'resistor', x: 20, y: 80, props: { ohms: 220 } },
      { id: 'led1', type: 'led', x: 40, y: 80, props: { color: 'red' } },
    ],
    wires: [
      { id: 'w1', from: 'uno1:D13', to: 'bb1:5A' },
      { id: 'w2', from: 'r1:a', to: 'bb1:5B' },
      { id: 'w3', from: 'r1:b', to: 'bb1:9B' },
      { id: 'w4', from: 'led1:anode', to: 'bb1:9C' },
      { id: 'w5', from: 'led1:cathode', to: 'bb1:10C' },
      { id: 'w6', from: 'bb1:10A', to: 'uno1:GND' },
    ],
    sketch: [],
    ...overrides,
  });
}

function build(project: Project) {
  return buildCircuit(project, { progMem: loadHex(blinkHex) });
}

describe('building a project', () => {
  it('builds Blink on a breadboard with no problems', () => {
    const { problems } = build(blinkOnBreadboard());
    expect(problems).toEqual([]);
  });

  it('lights the LED while the sketch holds D13 high', () => {
    const { board, devices } = build(blinkOnBreadboard());
    board.runFor(0.05);

    const led = devices.get('led1') as Led;
    expect(board.mcu.pinState('D13')).toBe('high');
    expect(led.brightness).toBeGreaterThan(0.5);
    // Through 220R from a 5 V pin: a real red LED lands in the low teens of milliamps.
    expect(led.current).toBeGreaterThan(0.01);
    expect(led.current).toBeLessThan(0.016);
  });

  it('darkens the LED when the sketch drives D13 low', () => {
    const { board, devices } = build(blinkOnBreadboard());
    board.runFor(0.6);

    const led = devices.get('led1') as Led;
    expect(board.mcu.pinState('D13')).toBe('low');
    expect(led.brightness).toBe(0);
  });

  it('raises no faults for a correctly built circuit', () => {
    const { board } = build(blinkOnBreadboard());
    board.runFor(0.05);
    expect(board.faults).toEqual([]);
  });

  describe('physical wiring mistakes', () => {
    it('breaks the circuit when a leg crosses the centre channel', () => {
      // Row F is on the far side of the channel from row B. The LED's anode is now on a strip
      // nothing else touches -- exactly what happens on a desk, and exactly what a logic-level
      // simulator cannot reproduce.
      const project = blinkOnBreadboard();
      project.wires = project.wires.map((w) =>
        w.id === 'w4' ? { ...w, to: 'bb1:9F' } : w,
      );

      const { board, devices } = build(project);
      board.runFor(0.05);

      const led = devices.get('led1') as Led;
      expect(led.brightness).toBe(0);
    });

    it('breaks the circuit when a leg lands one column over', () => {
      // Column 8 instead of 9: adjacent strips are not connected.
      const project = blinkOnBreadboard();
      project.wires = project.wires.map((w) => (w.id === 'w4' ? { ...w, to: 'bb1:8C' } : w));

      const { board, devices } = build(project);
      board.runFor(0.05);
      expect((devices.get('led1') as Led).brightness).toBe(0);
    });

    it('still works when a leg moves within the same five-hole strip', () => {
      // 9C, 9D and 9E are the same piece of metal, so this must make no difference at all.
      for (const hole of ['bb1:9C', 'bb1:9D', 'bb1:9E']) {
        const project = blinkOnBreadboard();
        project.wires = project.wires.map((w) => (w.id === 'w4' ? { ...w, to: hole } : w));

        const { board, devices } = build(project);
        board.runFor(0.05);
        expect((devices.get('led1') as Led).brightness).toBeGreaterThan(0.5);
      }
    });

    it('reports over-current when the resistor is left out', () => {
      // Wire D13 straight to the LED: the fault the whole project exists to catch.
      const project = blinkOnBreadboard();
      project.parts = project.parts.filter((p) => p.id !== 'r1');
      project.wires = [
        { id: 'w1', from: 'uno1:D13', to: 'bb1:5A', color: '#c0392b' },
        { id: 'w4', from: 'led1:anode', to: 'bb1:5C', color: '#c0392b' },
        { id: 'w5', from: 'led1:cathode', to: 'bb1:10C', color: '#c0392b' },
        { id: 'w6', from: 'bb1:10A', to: 'uno1:GND', color: '#c0392b' },
      ];

      const { board } = build(project);
      board.runFor(0.05);

      const fault = board.faults.find((f) => f.code === 'pin-over-current');
      expect(fault).toBeDefined();
      expect(fault!.subject).toBe('D13');
    });

    it('dims the LED when the resistor is too large', () => {
      const project = blinkOnBreadboard();
      project.parts = project.parts.map((p) =>
        p.id === 'r1' ? { ...p, props: { ohms: 10_000 } } : p,
      );

      const { board, devices } = build(project);
      board.runFor(0.05);

      const led = devices.get('led1') as Led;
      expect(led.brightness).toBeGreaterThan(0);
      expect(led.brightness).toBeLessThan(0.35);
    });
  });

  describe('robustness', () => {
    it('reports an unknown part type rather than failing to open the project', () => {
      const project = blinkOnBreadboard();
      project.parts.push({ id: 'x1', type: 'flux-capacitor', x: 0, y: 0, rotation: 0, props: {} });

      const { problems, devices } = build(project);
      expect(problems.some((p) => p.includes('flux-capacitor'))).toBe(true);
      // The rest of the circuit still built.
      expect(devices.has('led1')).toBe(true);
    });

    it('reports a wire to a terminal that does not exist', () => {
      const project = blinkOnBreadboard();
      project.wires.push({ id: 'wX', from: 'uno1:D13', to: 'nope:1', color: '#000' });

      const { problems } = build(project);
      expect(problems.some((p) => p.includes('wX'))).toBe(true);
    });

    it('builds an empty project without crashing', () => {
      const { board, problems } = build(parseProject({ version: 1 }));
      expect(problems).toEqual([]);
      expect(() => board.runFor(0.001)).not.toThrow();
    });
  });

  describe('project schema', () => {
    it('fills in defaults', () => {
      const project = parseProject({ version: 1, parts: [{ id: 'a', type: 'led', x: 0, y: 0 }] });
      expect(project.parts[0]!.rotation).toBe(0);
      expect(project.parts[0]!.props).toEqual({});
      expect(project.name).toBe('Untitled');
    });

    it('rejects a project with the wrong version', () => {
      expect(() => parseProject({ version: 2 })).toThrow();
    });

    it('round-trips through JSON unchanged', () => {
      const project = blinkOnBreadboard();
      expect(parseProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
    });
  });
});
