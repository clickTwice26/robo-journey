/**
 * Acting on several parts at once.
 *
 * The interesting cases are all about wires, because a wire belongs to two parts and every bulk
 * operation has to decide what that means. Duplicating half a connection, or deleting a part and
 * leaving a wire pointing at a terminal that is gone, are both documents the rest of the app then
 * has to cope with -- so they are settled here instead.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installBuiltinManifests, parseProject } from '@robo-journey/parts';
import { useStudio } from '../src/store.ts';

installBuiltinManifests();

/** Two LEDs wired to each other, and a third wired to the Uno. */
const scene = () =>
  parseProject({
    version: 1,
    parts: [
      { id: 'uno1', type: 'arduino-uno', x: 0, y: 0 },
      { id: 'le1', type: 'led', x: 20.32, y: 20.32 },
      { id: 'le2', type: 'led', x: 40.64, y: 20.32 },
      { id: 'le3', type: 'led', x: 60.96, y: 20.32 },
    ],
    wires: [
      { id: 'w1', from: 'le1:A', to: 'le2:C', color: '#c0392b' },
      { id: 'w2', from: 'le3:A', to: 'uno1:D13', color: '#c0392b' },
    ],
  });

const store = () => useStudio.getState();

beforeEach(() => {
  useStudio.getState().loadProject(scene());
  useStudio.getState().setSelection(null);
});

describe('selection', () => {
  it('replaces on a plain set and appends on a toggle', () => {
    store().setSelection('le1');
    expect(store().selectedIds).toEqual(['le1']);
    store().toggleSelected('le2');
    expect(store().selectedIds).toEqual(['le1', 'le2']);
    store().toggleSelected('le1');
    expect(store().selectedIds).toEqual(['le2']);
  });

  it('takes a whole list, so a rubber band lands in one go', () => {
    store().setSelection(['le1', 'le2', 'le3']);
    expect(store().selectedIds).toEqual(['le1', 'le2', 'le3']);
    store().setSelection(null);
    expect(store().selectedIds).toEqual([]);
  });

  it('selects every part, boards included', () => {
    store().selectAll();
    expect(store().selectedIds).toHaveLength(4);
  });
});

describe('nudgeSelection', () => {
  it('moves everything selected by the same offset, in one history entry', () => {
    const before = store().past.length;
    store().setSelection(['le1', 'le2']);
    store().nudgeSelection(2.54, -2.54);

    const parts = store().project.parts;
    expect(parts.find((p) => p.id === 'le1')).toMatchObject({ x: 22.86, y: 17.78 });
    expect(parts.find((p) => p.id === 'le2')).toMatchObject({ x: 43.18, y: 17.78 });
    // Untouched, and one undo puts the pair back rather than two.
    expect(parts.find((p) => p.id === 'le3')).toMatchObject({ x: 60.96, y: 20.32 });
    expect(store().past.length).toBe(before + 1);
  });

  it('does nothing with an empty selection, including to the undo stack', () => {
    const before = store().past.length;
    store().nudgeSelection(10, 10);
    expect(store().past.length).toBe(before);
  });
});

describe('rotateSelection', () => {
  it('turns each part about its own centre and wraps the angle', () => {
    store().setSelection(['le1', 'le2']);
    store().rotateSelection(90);
    store().rotateSelection(-180);
    const parts = store().project.parts;
    expect(parts.find((p) => p.id === 'le1')?.rotation).toBe(270);
    expect(parts.find((p) => p.id === 'le3')?.rotation).toBe(0);
  });
});

describe('removeSelection', () => {
  it('takes the wires attached to what it removes', () => {
    store().setSelection(['le1', 'le3']);
    store().removeSelection();

    expect(store().project.parts.map((p) => p.id).sort()).toEqual(['le2', 'uno1']);
    // w1 touched le1 and w2 touched le3; both go, or the document points at dead terminals.
    expect(store().project.wires).toHaveLength(0);
    expect(store().selectedIds).toEqual([]);
  });

  it('leaves a wire alone when neither end was selected', () => {
    store().setSelection(['le1', 'le2']);
    store().removeSelection();
    expect(store().project.wires.map((w) => w.id)).toEqual(['w2']);
  });
});

describe('duplicateSelection', () => {
  it('copies the parts and gives them ids nothing else is using', () => {
    store().setSelection(['le1', 'le2']);
    store().duplicateSelection();

    const ids = store().project.parts.map((p) => p.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it('offsets the copies so they are visibly not the originals', () => {
    store().setSelection(['le1']);
    store().duplicateSelection();
    const copy = store().project.parts.find((p) => p.id === store().selectedIds[0]);
    expect(copy).toMatchObject({ type: 'led', x: 22.86, y: 22.86 });
  });

  it('selects the copies, so the next drag moves what was just made', () => {
    store().setSelection(['le1', 'le2']);
    store().duplicateSelection();
    expect(store().selectedIds).toHaveLength(2);
    expect(store().selectedIds).not.toContain('le1');
  });

  it('copies a wire whose both ends were copied, pointing at the copies', () => {
    store().setSelection(['le1', 'le2']);
    store().duplicateSelection();

    const copies = new Set(store().selectedIds);
    const fresh = store().project.wires.filter((w) => !['w1', 'w2'].includes(w.id));
    expect(fresh).toHaveLength(1);
    // Rewritten to the copies -- a copy still wired to the original would be a second load on it.
    expect(copies.has(fresh[0]!.from.split(':')[0]!)).toBe(true);
    expect(copies.has(fresh[0]!.to.split(':')[0]!)).toBe(true);
  });

  it('leaves behind a wire with one end outside the selection', () => {
    store().setSelection(['le3']);
    store().duplicateSelection();
    // w2 ran from le3 to the Uno, which was not copied. Copying it would silently double the
    // load on D13.
    expect(store().project.wires.map((w) => w.id)).toEqual(['w1', 'w2']);
  });
});

describe('arrangeSelection', () => {
  it('needs two parts to mean anything', () => {
    const before = store().past.length;
    store().setSelection(['le1']);
    store().arrangeSelection('left');
    expect(store().past.length).toBe(before);
  });

  it('lines the selection up and leaves everything else where it was', () => {
    store().setSelection(['le1', 'le2', 'le3']);
    store().arrangeSelection('left');
    const parts = store().project.parts;
    expect(parts.find((p) => p.id === 'le2')?.x).toBe(20.32);
    expect(parts.find((p) => p.id === 'le3')?.x).toBe(20.32);
    expect(parts.find((p) => p.id === 'uno1')?.x).toBe(0);
  });
});
