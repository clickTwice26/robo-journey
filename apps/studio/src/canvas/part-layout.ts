/**
 * Where a generic part's name and pin labels go.
 *
 * Pure geometry, kept out of the component so it can be tested. It is worth testing: the first
 * version assumed pins sat near the top of the body and placed the name at a fixed offset below
 * them, which was right for nothing in particular and wrong for both shapes that actually occur.
 * A module with one header along an edge had its name drawn through its own pin labels and its
 * package type pushed off the body entirely; a DIP with a row on each edge had nowhere to put a
 * name at all.
 */
import type { PartDefinition } from '@robo-journey/parts';

/**
 * How a generic part lays itself out.
 *
 * A manifest can put its pins anywhere, and the two common shapes pull in opposite directions. A
 * DIP has a row along each long edge with the name silkscreened between them; a breakout module
 * has one header along an edge and a large empty body. A layout that assumes either one is wrong
 * for the other -- the first version assumed pins near the top and put the name at a fixed offset
 * below them, which on a module drew the name straight through its own pin labels and pushed the
 * package type clean off the body.
 *
 * So nothing is assumed. The pins are grouped into rows, the gaps between and around those rows
 * are measured, and the name takes the largest gap. Labels lean into whichever gap is adjacent to
 * their own row, which is what puts a DIP's two rows facing each other the way a real one is
 * printed.
 */
export interface Band {
  readonly top: number;
  readonly bottom: number;
}

export const bandHeightOf = (band: Band): number => band.bottom - band.top;

/**
 * The key a pin row is grouped and looked up by.
 *
 * Rounded, because pins on one edge share a y and floating-point noise from a normalised manifest
 * should not split one row into several -- but only to a hundredth of a millimetre. A tenth turned
 * a DIP's 7.62 mm row into 7.6, so the lookup missed and every label on that row fell back to the
 * default direction, pointing off the package.
 */
export const rowKey = (pin: { y: number }): number => Math.round(pin.y * 100) / 100;

export interface BodyLayout {
  /** Where the name goes, in millimetres. Null when nothing legible fits anywhere. */
  readonly titleBand: Band | null;
  /** For each pin row's y, whether its labels read upward. */
  readonly labelUp: ReadonlyMap<number, boolean>;
  /** Whether labels are drawn at all. */
  readonly labelsFit: boolean;
}

/**
 * Largest font size at which a string still fits one line.
 *
 * An approximation from average glyph advance rather than a real measurement: measuring means a
 * canvas context and a cache, and being a fraction of a pixel out here costs nothing while being
 * an entire wrapped line out costs the layout below it.
 */
const AVERAGE_GLYPH_ADVANCE = 0.58;
const MIN_READABLE_FONT = 3.5;

export function fitText(text: string, available: number, preferred: number): number {
  if (text.length === 0) return preferred;
  const needed = available / (text.length * AVERAGE_GLYPH_ADVANCE);
  return Math.max(MIN_READABLE_FONT, Math.min(preferred, needed));
}

/** Roughly what one rotated character occupies along the body, at the label's font size. */
const LABEL_MM_PER_CHAR = 0.62;
/** Clearance between a pin and the start of its label. */
const LABEL_CLEARANCE_MM = 1.2;

export function bodyLayout(definition: PartDefinition, titleMm: number): BodyLayout {
  const rows = [...new Set(definition.pins.map(rowKey))].sort((a, b) => a - b);
  if (rows.length === 0) {
    return { titleBand: { top: 0, bottom: definition.height }, labelUp: new Map(), labelsFit: false };
  }

  const bands: Band[] = [
    { top: 0, bottom: rows[0]! },
    ...rows.slice(0, -1).map((row, index) => ({ top: row, bottom: rows[index + 1]! })),
    { top: rows.at(-1)!, bottom: definition.height },
  ];

  const longest = Math.max(0, ...definition.pins.map((pin) => pin.name.length));
  const labelLength = longest * LABEL_MM_PER_CHAR + LABEL_CLEARANCE_MM;

  // Each row leans into its larger neighbour. On a DIP that faces the two rows inward; on a module
  // it points the single row into the empty body.
  const labelUp = new Map<number, boolean>();
  for (const [index, row] of rows.entries()) {
    const above = bandHeightOf(bands[index]!);
    const below = bandHeightOf(bands[index + 1]!);
    labelUp.set(row, above > below);
  }

  const widest = bands.reduce((best, band) =>
    bandHeightOf(band) > bandHeightOf(best) ? band : best,
  );

  // The name and the labels compete for the same gap, and the name wins: hovering a pin names it
  // at any size, but nothing else says which part this is.
  const spare = bandHeightOf(widest) - titleMm;
  const labelsFit = spare >= labelLength;
  const title = bandHeightOf(widest) >= titleMm ? widest : null;

  if (title && labelsFit) {
    // Take the labels off whichever end of the band a pin row actually borders.
    const bordersAbove = rows.includes(title.top);
    return {
      titleBand: bordersAbove
        ? { top: title.top + labelLength, bottom: title.bottom }
        : { top: title.top, bottom: title.bottom - labelLength },
      labelUp,
      labelsFit,
    };
  }

  return { titleBand: title, labelUp, labelsFit };
}
