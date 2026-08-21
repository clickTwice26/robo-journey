/**
 * The agent's vocabulary, and what happens when the model does not speak it properly.
 *
 * `parsePlan` sits directly on model output, which is the one input in this system that is neither
 * typed nor trusted. Every case here is something a language model actually does: fencing JSON it
 * was told not to fence, inventing a field, returning prose when it meant to decline.
 */
import { describe, expect, it } from 'vitest';
import { describeAction, parsePlan, subjectOf, type AgentAction } from '../src/index.js';

const plan = (actions: unknown[]) => JSON.stringify({ summary: 'Doing a thing', actions });

describe('reading a plan', () => {
  it('reads a plain object', () => {
    const parsed = parsePlan(plan([{ kind: 'removePart', id: 'r1', note: 'not needed' }]));
    expect(parsed?.actions).toHaveLength(1);
    expect(parsed?.summary).toBe('Doing a thing');
  });

  it('reads one the model fenced anyway', () => {
    // It is told not to. It sometimes does.
    const parsed = parsePlan('```json\n' + plan([]) + '\n```');
    expect(parsed?.actions).toEqual([]);
  });

  it('accepts an empty plan, which is a real answer', () => {
    // Declining to act is the right reply to a question, and to a request it cannot carry out.
    const parsed = parsePlan(JSON.stringify({ summary: 'I would need a part you do not have.', actions: [] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.actions).toEqual([]);
  });

  it('returns null for prose rather than throwing', () => {
    expect(parsePlan('Your resistor is too large.')).toBeNull();
    expect(parsePlan('')).toBeNull();
  });

  it('rejects a plan with an action it does not know', () => {
    expect(parsePlan(plan([{ kind: 'launchMissile', note: 'why not' }]))).toBeNull();
  });

  it('rejects an action missing the reason for it', () => {
    // The note is not decoration: the plan list shows it, and a step nobody can explain is a step
    // nobody should approve.
    expect(parsePlan(plan([{ kind: 'removePart', id: 'r1' }]))).toBeNull();
  });

  it('rejects a plan longer than the cap', () => {
    const many = Array.from({ length: 41 }, () => ({ kind: 'removePart', id: 'r1', note: 'x' }));
    expect(parsePlan(plan(many))).toBeNull();
  });

  it('rejects a coordinate that is not a number', () => {
    expect(parsePlan(plan([{ kind: 'movePart', id: 'r1', x: 'left', y: 2, note: 'x' }]))).toBeNull();
  });
});

describe('describing an action', () => {
  const cases: [AgentAction, RegExp][] = [
    [{ kind: 'setSketch', contents: 'void setup(){}', note: 'n' }, /sketch/i],
    [{ kind: 'addPart', id: 'r2', type: 'resistor', x: 0, y: 0, note: 'n' }, /resistor.*r2/],
    [{ kind: 'addWire', from: 'uno1:D13', to: 'r2:a', note: 'n' }, /uno1:D13.*r2:a/],
    [{ kind: 'setProp', id: 'r2', key: 'ohms', value: 330, note: 'n' }, /ohms.*330/],
  ];

  it.each(cases)('says what %o does', (action, pattern) => {
    expect(describeAction(action)).toMatch(pattern);
  });

  it('names the part a step is about, so the canvas can light it up', () => {
    expect(subjectOf({ kind: 'rotatePart', id: 'fs1', rotation: 90, note: 'n' })).toBe('fs1');
    expect(subjectOf({ kind: 'addWire', from: 'uno1:D13', to: 'r2:a', note: 'n' })).toBe('uno1');
    // A sketch rewrite is about no part in particular.
    expect(subjectOf({ kind: 'setSketch', contents: 'x', note: 'n' })).toBeNull();
  });
});
