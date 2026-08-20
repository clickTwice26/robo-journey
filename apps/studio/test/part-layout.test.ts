/**
 * Where a generic part's name and pin labels go.
 *
 * These are here because the layout was wrong in a way that looked plausible: the name was placed
 * at a fixed offset below the pin row, which is fine for a part with pins near the top and
 * produces, for a breakout module with one header along the bottom, a name drawn through its own
 * pin labels and a package type printed off the bottom of the body. The bug was visible on screen
 * and invisible to every test, because nothing tested it.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MANIFESTS,
  manifestToPartDefinition,
  type PartDefinition,
  type PartPin,
} from '@robo-journey/parts';
import { bandHeightOf, bodyLayout, fitText } from '../src/canvas/part-layout.ts';

const pin = (name: string, x: number, y: number): PartPin => ({ name, x, y });

function part(over: Partial<PartDefinition> & { pins: PartPin[] }): PartDefinition {
  return {
    type: 'test',
    label: 'Test',
    category: 'passive',
    width: 16,
    height: 20,
    defaults: {},
    ...over,
  } as PartDefinition;
}

/** A breakout module: one header along the bottom edge, the rest of the body empty. */
const MODULE = part({
  height: 20.3,
  pins: ['VCC', 'GND', 'CS', 'SDO', 'SDA', 'SCL'].map((name, i) =>
    pin(name, 2.54 + i * 2.54, 18),
  ),
});

/** A DIP: a row along each long edge, nothing but body in between. */
const DIP = part({
  width: 19.3,
  height: 8.82,
  pins: [
    ...['QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', 'GND'].map((name, i) =>
      pin(name, 2.54 + i * 2.54, 0),
    ),
    ...['QH*', 'SRCLR', 'SRCLK', 'RCLK', 'OE', 'SER', 'QA', 'VCC'].map((name, i) =>
      pin(name, 2.54 + i * 2.54, 7.62),
    ),
  ],
});

/**
 * What a name plus a package type occupies, in millimetres.
 *
 * The figure the component passes for a DIP-16: a 9 px name over a 6 px package type at five
 * pixels to the millimetre. Using a smaller number here made the DIP look roomier than it is and
 * a test asserting that labels get dropped passed for the wrong reason.
 */
const TITLE_MM = 3.4;

describe('a module with one pin row', () => {
  it('puts the name in the empty body, not over the pins', () => {
    const layout = bodyLayout(MODULE, TITLE_MM);
    expect(layout.titleBand).not.toBeNull();
    // Entirely above the pin row rather than straddling it.
    expect(layout.titleBand!.bottom).toBeLessThanOrEqual(18);
  });

  it('points the labels into the body', () => {
    // Downward would run them off the bottom edge, which is 2.3 mm away.
    const layout = bodyLayout(MODULE, TITLE_MM);
    expect(layout.labelsFit).toBe(true);
    expect(layout.labelUp.get(18)).toBe(true);
  });

  it('leaves room for the labels before placing the name', () => {
    const layout = bodyLayout(MODULE, TITLE_MM);
    // The labels take the end of the band nearest the pins; the name takes what is left.
    expect(layout.titleBand!.bottom).toBeLessThan(18);
    expect(bandHeightOf(layout.titleBand!)).toBeGreaterThan(TITLE_MM);
  });

  it('keeps everything inside the body', () => {
    const layout = bodyLayout(MODULE, TITLE_MM);
    expect(layout.titleBand!.top).toBeGreaterThanOrEqual(0);
    expect(layout.titleBand!.bottom).toBeLessThanOrEqual(MODULE.height);
  });
});

describe('a DIP with a row on each edge', () => {
  it('puts the name between the rows, the way one is actually printed', () => {
    const layout = bodyLayout(DIP, TITLE_MM);
    expect(layout.titleBand).not.toBeNull();
    expect(layout.titleBand!.top).toBeGreaterThanOrEqual(0);
    expect(layout.titleBand!.bottom).toBeLessThanOrEqual(7.62);
  });

  it('faces the two rows inward', () => {
    const layout = bodyLayout(DIP, TITLE_MM);
    // The top row reads downward and the bottom row upward, both into the gap between them --
    // outward would put them off the package.
    expect(layout.labelUp.get(0)).toBe(false);
    expect(layout.labelUp.get(7.62)).toBe(true);
  });

  it('drops labels rather than the name when only one fits', () => {
    // 'SRCLR' needs about 4.3 mm of the 7.62 mm gap and the name needs the rest, so on a DIP-16
    // they do not both fit. Hovering a pin names it at any size; nothing else says which part
    // this is, so the name wins.
    const layout = bodyLayout(DIP, TITLE_MM);
    expect(layout.labelsFit).toBe(false);
    expect(layout.titleBand).not.toBeNull();
  });
});

describe('a package with no room at all', () => {
  it('gives up on the name rather than drawing it off the body', () => {
    const tiny = part({ width: 6, height: 2.2, pins: [pin('A', 1, 0), pin('B', 1, 2)] });
    expect(bodyLayout(tiny, TITLE_MM).titleBand).toBeNull();
  });
});

describe('fitting text to a body', () => {
  it('leaves a name that fits at its preferred size', () => {
    expect(fitText('LM358', 60, 9)).toBe(9);
  });

  it('shrinks one that does not', () => {
    // An AMS1117-3.3 is eleven characters on a seven-millimetre package, which is the common case
    // rather than the edge one. Wrapping it puts the second line on whatever is below.
    const size = fitText('AMS1117-3.3', 30, 9);
    expect(size).toBeLessThan(9);
    expect(size * 'AMS1117-3.3'.length * 0.58).toBeLessThanOrEqual(30);
  });

  it('stops shrinking before it becomes unreadable', () => {
    expect(fitText('a-very-long-part-number-indeed', 10, 9)).toBeGreaterThanOrEqual(3.5);
  });
});

/**
 * The whole library, through the same layout the canvas uses.
 *
 * The generic layout was written against two shapes -- a header module and a DIP -- and the
 * library now has forty-five parts in a dozen. A component whose name lands on top of its own pin
 * labels is not a crash and not a test failure anywhere else; it is simply ugly, and it stays ugly
 * until someone happens to place that part. This is the sweep that notices first.
 */
describe('every built-in part', () => {
  const parts = BUILTIN_MANIFESTS.map((m) => manifestToPartDefinition(m));

  it.each(parts.map((p) => [p.type, p] as const))('%s keeps its name inside the body', (_type, definition) => {
    const layout = bodyLayout(definition, TITLE_MM);
    if (!layout.titleBand) return;
    expect(layout.titleBand.top).toBeGreaterThanOrEqual(0);
    expect(layout.titleBand.bottom).toBeLessThanOrEqual(definition.height);
    expect(bandHeightOf(layout.titleBand)).toBeGreaterThan(0);
  });

  it.each(parts.map((p) => [p.type, p] as const))('%s keeps its name off its pins', (_type, definition) => {
    const layout = bodyLayout(definition, TITLE_MM);
    if (!layout.titleBand) return;
    // A pin row inside the title band means the name is drawn straight through the labels.
    for (const pin of definition.pins) {
      const inside = pin.y > layout.titleBand.top && pin.y < layout.titleBand.bottom;
      expect(inside).toBe(false);
    }
  });

  it('finds room for the name on all but the smallest packages', () => {
    // Not every part can carry a name -- a 7 mm radial capacitor genuinely has nowhere to put one
    // -- but most should, and a sudden drop here would mean the layout regressed.
    const named = parts.filter((p) => bodyLayout(p, TITLE_MM).titleBand !== null);
    expect(named.length).toBeGreaterThan(parts.length * 0.75);
  });
});
