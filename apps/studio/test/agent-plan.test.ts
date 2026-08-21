/**
 * Checking what the agent proposes.
 *
 * This is the layer that stands between a language model and somebody's circuit, so it is the one
 * worth being sure about. The failure that matters is not a refusal -- it is a plan that reads
 * perfectly and wires D13 to a pin that does not exist, applied without complaint.
 *
 * Every case here is a plan that looks fine and is not.
 */
import { describe, expect, it } from 'vitest';
import { installBuiltinManifests, parseProject, type AgentAction } from '@robo-journey/parts';
import { checkPlan } from '../src/agent/plan.ts';

installBuiltinManifests();

const project = parseProject({
  version: 1,
  parts: [
    { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
    { id: 'bb1', type: 'breadboard-mini', x: 0, y: 63.5 },
    { id: 'r1', type: 'resistor', x: 10, y: 80, props: { ohms: 220 } },
  ],
  wires: [{ id: 'w1', from: 'uno1:D13', to: 'r1:a' }],
});

const note = 'because';

describe('a plan that can be carried out', () => {
  it('passes every step through', () => {
    const actions: AgentAction[] = [
      { kind: 'addPart', id: 'led1', type: 'led', x: 30, y: 80, note },
      { kind: 'addWire', from: 'r1:b', to: 'led1:anode', note },
      { kind: 'setProp', id: 'r1', key: 'ohms', value: 330, note },
    ];
    const checked = checkPlan(actions, project);
    expect(checked.steps.every((s) => s.problem === null)).toBe(true);
    expect(checked.runnable).toHaveLength(3);
  });

  it('lets a plan wire a part it added a moment ago', () => {
    // The common shape of a real plan, and the reason the check runs against a running picture of
    // the project rather than against the project as it stands now.
    const checked = checkPlan(
      [
        { kind: 'addPart', id: 'led1', type: 'led', x: 30, y: 80, note },
        { kind: 'addWire', from: 'led1:cathode', to: 'uno1:GND', note },
      ],
      project,
    );
    expect(checked.runnable).toHaveLength(2);
  });

  it('accepts a breadboard hole, which is a terminal but not a pin', () => {
    const checked = checkPlan([{ kind: 'addWire', from: 'uno1:D13', to: 'bb1:12A', note }], project);
    expect(checked.steps[0]!.problem).toBeNull();
  });
});

describe('a plan that cannot', () => {
  it('refuses a part type this app does not have', () => {
    const checked = checkPlan(
      [{ kind: 'addPart', id: 'x1', type: 'flux-capacitor', x: 0, y: 0, note }],
      project,
    );
    expect(checked.steps[0]!.problem).toMatch(/not a part/);
    expect(checked.runnable).toHaveLength(0);
  });

  it('refuses a pin the part does not have', () => {
    // The one that would otherwise look right on the canvas and do nothing in the circuit.
    const checked = checkPlan([{ kind: 'addWire', from: 'uno1:D99', to: 'r1:a', note }], project);
    expect(checked.steps[0]!.problem).toMatch(/no pin called/);
  });

  it('refuses a hole the breadboard does not have', () => {
    const checked = checkPlan([{ kind: 'addWire', from: 'uno1:D13', to: 'bb1:oops', note }], project);
    expect(checked.steps[0]!.problem).toMatch(/not a hole/);
  });

  it('refuses a part id that is not there', () => {
    for (const action of [
      { kind: 'movePart', id: 'ghost', x: 1, y: 1, note },
      { kind: 'rotatePart', id: 'ghost', rotation: 90, note },
      { kind: 'setProp', id: 'ghost', key: 'ohms', value: 1, note },
      { kind: 'removePart', id: 'ghost', note },
    ] as AgentAction[]) {
      expect(checkPlan([action], project).steps[0]!.problem).toMatch(/no part called/);
    }
  });

  it('refuses to add a part over an id already in use', () => {
    const checked = checkPlan(
      [{ kind: 'addPart', id: 'r1', type: 'led', x: 0, y: 0, note }],
      project,
    );
    expect(checked.steps[0]!.problem).toMatch(/already a part/);
  });

  it('refuses a wire to a part removed earlier in the same plan', () => {
    const checked = checkPlan(
      [
        { kind: 'removePart', id: 'r1', note },
        { kind: 'addWire', from: 'r1:a', to: 'uno1:D13', note },
      ],
      project,
    );
    expect(checked.steps[0]!.problem).toBeNull();
    expect(checked.steps[1]!.problem).toMatch(/no part called/);
  });

  it('refuses a wire with both ends on the same terminal', () => {
    const checked = checkPlan([{ kind: 'addWire', from: 'r1:a', to: 'r1:a', note }], project);
    expect(checked.steps[0]!.problem).toMatch(/same terminal/);
  });

  it('refuses a malformed terminal', () => {
    const checked = checkPlan([{ kind: 'addWire', from: 'nocolon', to: 'r1:a', note }], project);
    expect(checked.steps[0]!.problem).toMatch(/not a terminal/);
  });

  it('refuses an empty sketch', () => {
    const checked = checkPlan([{ kind: 'setSketch', contents: '   ', note }], project);
    expect(checked.steps[0]!.problem).toMatch(/empty/);
  });

  it('keeps the bad steps rather than dropping them', () => {
    // A quietly shorter plan is the worst outcome available: the user would believe all of it ran.
    const checked = checkPlan(
      [
        { kind: 'addPart', id: 'led1', type: 'led', x: 30, y: 80, note },
        { kind: 'addWire', from: 'led1:anode', to: 'uno1:D99', note },
      ],
      project,
    );
    expect(checked.steps).toHaveLength(2);
    expect(checked.runnable).toHaveLength(1);
  });
});

describe('a plan the model actually produced', () => {
  /**
   * Verbatim from a real call.
   *
   * Asked to fix an LED drawing 78 mA straight off D13, the model chose to pull the LED out, add a
   * 220 ohm resistor, put the LED back and rewire the three of them in series. Heavier-handed than
   * a person would be and entirely correct -- and it exercises the one case a naive checker gets
   * wrong: re-adding an id that an earlier step in the same plan removed.
   */
  const real: AgentAction[] = [
    { kind: 'removePart', id: 'led1', note: 'Remove LED to clear direct connections' },
    { kind: 'addPart', id: 'r1', type: 'resistor', x: 60, y: 40, props: { ohms: 220 }, note: 'Add 220 ohm current limiting resistor' },
    { kind: 'addPart', id: 'led1', type: 'led', x: 80, y: 40, props: { color: 'red' }, note: 'Re-add red LED' },
    { kind: 'addWire', from: 'uno1:D13', to: 'r1:a', note: 'Connect D13 to resistor' },
    { kind: 'addWire', from: 'r1:b', to: 'led1:anode', note: 'Connect resistor to LED anode' },
    { kind: 'addWire', from: 'led1:cathode', to: 'uno1:GND', note: 'Connect LED cathode to GND' },
  ];

  it('passes every step', () => {
    const scene = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'led1', type: 'led', x: 20, y: 90, props: { color: 'red' } },
      ],
      wires: [
        { id: 'w1', from: 'uno1:D13', to: 'led1:anode' },
        { id: 'w2', from: 'led1:cathode', to: 'uno1:GND' },
      ],
    });

    const checked = checkPlan(real, scene);
    const failures = checked.steps.filter((s) => s.problem !== null);
    expect(failures.map((f) => f.problem)).toEqual([]);
    expect(checked.runnable).toHaveLength(6);
  });

  it('knows the removed part took its wires with it', () => {
    // Removing led1 removes w1 and w2, so a later step cannot remove either of them again.
    const scene = parseProject({
      version: 1,
      parts: [
        { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
        { id: 'led1', type: 'led', x: 20, y: 90 },
      ],
      wires: [{ id: 'w1', from: 'uno1:D13', to: 'led1:anode' }],
    });

    const checked = checkPlan(
      [
        { kind: 'removePart', id: 'led1', note: 'n' },
        { kind: 'removeWire', id: 'w1', note: 'n' },
      ],
      scene,
    );
    expect(checked.steps[0]!.problem).toBeNull();
    expect(checked.steps[1]!.problem).toMatch(/no wire called/);
  });
});
