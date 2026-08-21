/**
 * Pins have to sit on the part they belong to, and look like they do.
 *
 * Reported from the app: the coin vibration motor's two terminals huddled in one corner of its
 * body while the SG90 beside it looked right. It was not one part. `row()` starts a header one
 * pitch from the left edge, which is fine for a part barely wider than its own header and wrong
 * for every module -- the LCD1602's four pins sat in the corner of an 80 mm board with 70 mm of
 * empty blue beside them, and thirty-odd other parts were somewhere in between.
 *
 * So this checks all of them rather than the one that was noticed.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MANIFESTS,
  PITCH_MM,
  allParts,
  installBuiltinManifests,
  partDefinition,
} from '../src/index.js';

installBuiltinManifests();

/** Parts with hand-drawn artwork place their own pins to match it; the rest are laid out for them. */
const MANIFEST_TYPES = new Set(BUILTIN_MANIFESTS.map((m) => m.id));

/**
 * A part's own pitch, which is not always the breadboard's.
 *
 * The AMS1117 is SOT-223 and its legs are 2.30 mm apart. It is a surface-mount part and does not
 * plug into anything; holding it to a 0.1" grid would be asserting a number off the wrong
 * datasheet.
 */
const pitchOf = (type: string): number =>
  BUILTIN_MANIFESTS.find((m) => m.id === type)?.package.pinPitchMm || PITCH_MM;

describe('pin placement', () => {
  it.each([...MANIFEST_TYPES].sort())('%s puts its pins across the body, not in a corner', (type) => {
    const definition = partDefinition(type);
    const xs = definition.pins.map((p) => p.x);
    const left = Math.min(...xs);
    const right = definition.width - Math.max(...xs);

    // Half a pitch either way is the floor: a three-pin header on a five-pitch body is equally
    // far from both edges at 2.54 and at 5.08, and centring it better would take the legs off
    // the hole grid. Anything worse is a part drawn wrong.
    expect(Math.abs(left - right), `${type} leans ${(left - right).toFixed(2)}mm`).toBeLessThanOrEqual(
      pitchOf(type) + 1e-6,
    );
  });

  it('keeps every pin inside the body it belongs to', () => {
    for (const definition of allParts()) {
      for (const pin of definition.pins) {
        expect(pin.x, `${definition.type}:${pin.name} x`).toBeGreaterThanOrEqual(0);
        expect(pin.y, `${definition.type}:${pin.name} y`).toBeGreaterThanOrEqual(0);
        expect(pin.x, `${definition.type}:${pin.name} x`).toBeLessThanOrEqual(definition.width);
        expect(pin.y, `${definition.type}:${pin.name} y`).toBeLessThanOrEqual(definition.height);
      }
    }
  });

  it('keeps neighbouring pins one pitch apart, so legs reach adjacent holes', () => {
    for (const type of MANIFEST_TYPES) {
      const pitch = pitchOf(type);
      const definition = partDefinition(type);
      // Within a row, which is what a breadboard cares about.
      const rows = new Map<number, number[]>();
      for (const pin of definition.pins) {
        rows.set(pin.y, [...(rows.get(pin.y) ?? []), pin.x]);
      }
      for (const [y, columns] of rows) {
        const sorted = [...columns].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i += 1) {
          const gap = sorted[i]! - sorted[i - 1]!;
          expect(gap, `${type} row y=${y} has a ${gap.toFixed(2)}mm gap`).toBeCloseTo(pitch, 6);
        }
      }
    }
  });

  it('keeps every pin on its own pitch grid, so a snapped part still plugs in', () => {
    // The canvas snaps a part's position to the pitch. An offset that is not a whole number of
    // pitches would put every leg permanently between two holes -- tidier on screen, and no
    // longer a part you can breadboard.
    for (const type of MANIFEST_TYPES) {
      const pitch = pitchOf(type);
      for (const pin of partDefinition(type).pins) {
        const steps = pin.x / pitch;
        expect(Math.abs(steps - Math.round(steps)), `${type}:${pin.name} x=${pin.x}`).toBeLessThan(
          1e-6,
        );
      }
    }
  });
});
