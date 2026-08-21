/**
 * Lining parts up, and spacing them out.
 *
 * Pure arithmetic on bounding boxes, which is exactly the kind of thing that looks right in a
 * screenshot and is off by half a part. The cases that matter are the ones where the parts are
 * different sizes: aligning by origin instead of by edge is the classic way to get this wrong, and
 * it only shows up when the parts are not all the same.
 */
import { describe, expect, it } from 'vitest';
import { PITCH_MM, installBuiltinManifests, type PartInstance } from '@robo-journey/parts';
import { arrange, boundsOf, boxOf } from '../src/canvas/arrange.ts';

installBuiltinManifests();

const at = (id: string, type: string, x: number, y: number, rotation = 0): PartInstance => ({
  id,
  type,
  x,
  y,
  rotation,
  props: {},
});

/** An LED is 5 x 5 mm; the SG90 is 23.0 x 12.2. Different sizes, on purpose. */
const led = (id: string, x: number, y: number) => at(id, 'led', x, y);
const servo = (id: string, x: number, y: number) => at(id, 'sg90', x, y);

describe('boxOf', () => {
  it('measures a part as it is drawn', () => {
    expect(boxOf(servo('s', 10, 20))).toMatchObject({ x: 10, y: 20, width: 23, height: 12.2 });
  });

  it('swaps the sides at a quarter turn, because that is how it looks', () => {
    expect(boxOf(at('s', 'sg90', 0, 0, 90))).toMatchObject({ width: 12.2, height: 23 });
    expect(boxOf(at('s', 'sg90', 0, 0, 270))).toMatchObject({ width: 12.2, height: 23 });
    // Half a turn puts it back the way it was.
    expect(boxOf(at('s', 'sg90', 0, 0, 180))).toMatchObject({ width: 23, height: 12.2 });
  });

  it('treats a part it has never heard of as a point rather than throwing', () => {
    expect(boxOf(at('x', 'no-such-part', 4, 5))).toMatchObject({ x: 4, y: 5, width: 0, height: 0 });
  });
});

describe('arrange', () => {
  it('does nothing to fewer than two parts', () => {
    expect(arrange([led('a', 0, 0)], 'left').size).toBe(0);
    expect(arrange([], 'space-x').size).toBe(0);
  });

  it('aligns left edges, not origins', () => {
    const moved = arrange([led('a', 50, 0), servo('b', 20, 30)], 'left');
    // The servo is already leftmost, so only the LED moves -- and it moves to the servo's edge.
    expect(moved.get('a')?.x).toBe(20.32);
    expect(moved.has('b')).toBe(false);
  });

  it('aligns right edges by the far side of each part', () => {
    const moved = arrange([led('a', 0, 0), servo('b', 0, 30)], 'right');
    // The servo's right edge is at 23; the LED is 5 wide, so its left edge goes to 18 -- snapped.
    expect(moved.get('a')?.x).toBeCloseTo(17.78, 6);
    expect(moved.has('b')).toBe(false);
  });

  it('centres by the middle of each part, so different sizes still line up', () => {
    const moved = arrange([led('a', 0, 0), servo('b', 0, 30)], 'centre-x');
    const ledCentre = (moved.get('a')?.x ?? 0) + 5 / 2;
    const servoCentre = (moved.get('b')?.x ?? 0) + 23 / 2;
    // Within half a hole: both are snapped to the grid, so exact equality is not on offer.
    expect(Math.abs(ledCentre - servoCentre)).toBeLessThanOrEqual(PITCH_MM / 2);
  });

  it('leaves the other axis alone', () => {
    const moved = arrange([led('a', 50, 7), servo('b', 20, 30)], 'left');
    expect(moved.get('a')?.y).toBe(7);
  });

  it('spaces evenly by gap, not by position', () => {
    // Three parts of different widths. Equal *gaps* is the goal; equal positions would bunch the
    // wide one against its neighbour.
    const parts = [led('a', 0, 0), servo('b', 40, 0), led('c', 100, 0)];
    const moved = arrange(parts, 'space-x');

    const xOf = (id: string, fallback: number) => moved.get(id)?.x ?? fallback;
    const gapOne = xOf('b', 40) - (xOf('a', 0) + 5);
    const gapTwo = xOf('c', 100) - (xOf('b', 40) + 23);
    expect(Math.abs(gapOne - gapTwo)).toBeLessThanOrEqual(PITCH_MM);
  });

  it('keeps the outermost parts where they are when spacing', () => {
    const moved = arrange([led('a', 0, 0), servo('b', 40, 0), led('c', 100, 0)], 'space-x');
    expect(moved.has('a')).toBe(false);
    expect(moved.get('c')?.x ?? 100).toBe(100);
  });

  it('spaces in the order they appear on the canvas, not in the document', () => {
    // 'c' is listed first but sits rightmost; spacing must not shuffle them.
    const moved = arrange([led('c', 100, 0), led('a', 0, 0), led('b', 40, 0)], 'space-x');
    const x = (id: string, fallback: number) => moved.get(id)?.x ?? fallback;
    expect(x('a', 0)).toBeLessThan(x('b', 40));
    expect(x('b', 40)).toBeLessThan(x('c', 100));
  });

  it('puts whatever it moves onto the hole grid, and leaves the rest alone', () => {
    // Deliberately off-grid to start with, which is the case that tells the two apart: a
    // coordinate the operation does not touch must come back untouched, off-grid and all.
    const parts = [led('a', 3.1, 5.3), servo('b', 41.7, 5.3), led('c', 99.3, 5.3)];
    const onGrid = (mm: number) => Math.abs(mm / PITCH_MM - Math.round(mm / PITCH_MM)) < 1e-9;

    for (const how of ['left', 'centre-x', 'right', 'top', 'centre-y', 'bottom', 'space-x', 'space-y'] as const) {
      for (const [id, at] of arrange(parts, how)) {
        const before = parts.find((p) => p.id === id)!;
        if (at.x !== before.x) expect(onGrid(at.x), `${how} left ${id} off the grid in x`).toBe(true);
        else expect(at.x).toBe(before.x);
        if (at.y !== before.y) expect(onGrid(at.y), `${how} left ${id} off the grid in y`).toBe(true);
        else expect(at.y).toBe(before.y);
      }
    }
  });
});

describe('boundsOf', () => {
  it('covers every box', () => {
    expect(boundsOf([boxOf(led('a', 0, 0)), boxOf(servo('b', 40, 30))])).toMatchObject({
      x: 0,
      y: 0,
      width: 63,
      height: 42.2,
    });
  });
});
