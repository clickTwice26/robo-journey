/**
 * New parts must not be handed an id the project is already using.
 *
 * The id counter lives in module scope, so it restarts at zero every time the page loads. Open a
 * saved project -- whose ids were produced by a previous run of that same counter -- and the next
 * part placed is handed an id the document already contains. Two parts with one id share a single
 * device in the engine, so the second one placed silently stops responding.
 */
import { describe, expect, it } from 'vitest';
import { emptyProject, parseProject } from '@robo-journey/parts';
import { nextId, useStudio } from '../src/store.ts';

/** A project of the shape a previous session would have saved: counter-generated ids. */
function restored() {
  return parseProject({
    version: 1,
    parts: [
      { id: 'st1', type: 'stim-heat', x: 0, y: 0 },
      { id: 'st2', type: 'stim-lamp', x: 20, y: 0 },
      { id: 'so3', type: 'soil-moisture', x: 40, y: 0 },
    ],
    wires: [{ id: 'w4', from: 'uno1:D13', to: 'uno1:GND', color: '#c0392b' }],
  });
}

describe('nextId', () => {
  it('skips ids a restored project already contains', () => {
    useStudio.getState().loadProject(restored());

    // Four fresh ids, none of which may collide with st1, st2, so3 or w4.
    const taken = new Set(['st1', 'st2', 'so3', 'w4']);
    for (let i = 0; i < 4; i += 1) {
      const id = nextId('st');
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
  });

  it('still only moves forward, so ids are stable within a session', () => {
    useStudio.getState().loadProject(emptyProject('Blink'));
    const first = Number(nextId('le').slice(2));
    const second = Number(nextId('le').slice(2));
    expect(second).toBeGreaterThan(first);
  });

  it('keeps parts and wires from colliding with one another', () => {
    useStudio.getState().loadProject(restored());
    const ids = new Set<string>();
    for (let i = 0; i < 6; i += 1) ids.add(nextId(i % 2 === 0 ? 'w' : 'st'));
    expect(ids.size).toBe(6);
    expect(ids.has('w4')).toBe(false);
    expect(ids.has('st1')).toBe(false);
  });
});
