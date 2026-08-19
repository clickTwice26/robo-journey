/**
 * Breadboard topology.
 *
 * A breadboard is not a grid of independent holes -- it is a set of internal metal strips, and
 * which strip a hole belongs to is the entire reason breadboards work. Getting this exactly right
 * is what makes the simulator physical: a leg in row 12A is genuinely connected to 12E and
 * genuinely not connected to 12F, so a wire in the wrong row fails here the way it fails on a desk.
 *
 * Hole ids are the labels printed on the board itself ("12A", "+ top 3"), so what a user reads on
 * screen is what appears in the project file and in any error message.
 */
import type { Netlist } from './netlist.js';

/** Rows above the centre channel. */
export const UPPER_ROWS = ['A', 'B', 'C', 'D', 'E'] as const;
/** Rows below the centre channel. */
export const LOWER_ROWS = ['F', 'G', 'H', 'I', 'J'] as const;
export const ALL_ROWS = [...UPPER_ROWS, ...LOWER_ROWS] as const;

export type BreadboardRow = (typeof ALL_ROWS)[number];

export interface BreadboardSpec {
  /** Numbered columns. 30 for a half-size board, 63 for a full-size one. */
  readonly columns: number;
  /** Whether the board carries the four power rails along its edges. */
  readonly powerRails: boolean;
  /**
   * How many electrically separate segments each power rail is divided into.
   *
   * Most boards break their rails in the middle, which is a classic source of "why is half my
   * circuit dead" -- so it is modelled rather than smoothed over. 1 means a continuous rail.
   */
  readonly railSegments: number;
}

/**
 * Mini, 170 tie points. No power rails -- the small ones do not have them.
 *
 * The right default for a first circuit: an LED and a resistor need three strips, and a 30-column
 * board next to them is mostly empty plastic taking up screen.
 */
export const MINI_BREADBOARD: BreadboardSpec = {
  columns: 17,
  powerRails: false,
  railSegments: 1,
};

/** Half-size, 400 tie points. Fits an Uno and a small circuit. */
export const HALF_SIZE_BREADBOARD: BreadboardSpec = {
  columns: 30,
  powerRails: true,
  railSegments: 2,
};

/** Full-size, 830 tie points. */
export const FULL_SIZE_BREADBOARD: BreadboardSpec = {
  columns: 63,
  powerRails: true,
  railSegments: 2,
};

export type RailSide = 'top' | 'bottom';
export type RailPolarity = 'positive' | 'negative';

/** Terminal id for a numbered hole, e.g. `bb1:12A`. */
export function holeId(board: string, column: number, row: BreadboardRow): string {
  return `${board}:${column}${row}`;
}

/** Terminal id for a power-rail hole. */
export function railHoleId(
  board: string,
  side: RailSide,
  polarity: RailPolarity,
  column: number,
): string {
  return `${board}:${side}-${polarity === 'positive' ? '+' : '-'}${column}`;
}

/** Which segment of a split rail a column falls in. */
export function railSegmentOf(spec: BreadboardSpec, column: number): number {
  if (spec.railSegments <= 1) return 0;
  const perSegment = spec.columns / spec.railSegments;
  return Math.min(spec.railSegments - 1, Math.floor((column - 1) / perSegment));
}

/**
 * Register a breadboard's internal connectivity into a netlist.
 *
 * Each numbered column contributes two independent five-hole strips, one either side of the centre
 * channel. Each power rail contributes one strip per segment.
 */
export function addBreadboard(
  netlist: Netlist,
  board: string,
  spec: BreadboardSpec = HALF_SIZE_BREADBOARD,
): void {
  for (let column = 1; column <= spec.columns; column++) {
    // The centre channel is the whole point: two separate strips, not one of ten holes.
    netlist.connectAll(UPPER_ROWS.map((row) => holeId(board, column, row)));
    netlist.connectAll(LOWER_ROWS.map((row) => holeId(board, column, row)));
  }

  if (!spec.powerRails) return;

  for (const side of ['top', 'bottom'] as const) {
    for (const polarity of ['positive', 'negative'] as const) {
      // Group columns by segment, then join each group.
      const segments = new Map<number, string[]>();
      for (let column = 1; column <= spec.columns; column++) {
        const segment = railSegmentOf(spec, column);
        const holes = segments.get(segment) ?? [];
        holes.push(railHoleId(board, side, polarity, column));
        segments.set(segment, holes);
      }
      for (const holes of segments.values()) netlist.connectAll(holes);
    }
  }
}

/** Every hole id on a board, for rendering and for validating a project file. */
export function breadboardHoles(board: string, spec: BreadboardSpec): string[] {
  const holes: string[] = [];
  for (let column = 1; column <= spec.columns; column++) {
    for (const row of ALL_ROWS) holes.push(holeId(board, column, row));
  }
  if (spec.powerRails) {
    for (const side of ['top', 'bottom'] as const) {
      for (const polarity of ['positive', 'negative'] as const) {
        for (let column = 1; column <= spec.columns; column++) {
          holes.push(railHoleId(board, side, polarity, column));
        }
      }
    }
  }
  return holes;
}

// ---------------------------------------------------------------------------------------------
// Physical layout
// ---------------------------------------------------------------------------------------------

/**
 * Where each row sits, in pitch units down from the board's top edge.
 *
 * Shared by the canvas geometry and the artwork so a hole cannot be drawn in one place and wired
 * in another. A board without power rails starts its numbered rows two pitches higher, because
 * there is no rail to leave room for.
 *
 * The centre channel occupies one full pitch between rows E and F, which is exactly why a DIP chip
 * straddling it lands one row of legs on each side.
 */
export function rowOffset(spec: BreadboardSpec, row: BreadboardRow): number {
  const base = spec.powerRails ? 3 : 1;
  const index = ALL_ROWS.indexOf(row);
  // Rows F-J sit one extra pitch down, across the channel.
  return base + index + (index >= UPPER_ROWS.length ? 1 : 0);
}

/** Where a power rail sits, in pitch units from the top edge. Null when the board has none. */
export function railOffset(
  spec: BreadboardSpec,
  side: RailSide,
  polarity: RailPolarity,
): number | null {
  if (!spec.powerRails) return null;
  const positive = polarity === 'positive';
  if (side === 'top') return positive ? 0.5 : 1.5;
  // Bottom rails sit below row J plus a margin.
  return rowOffset(spec, 'J') + (positive ? 1.5 : 2.5);
}

/** The channel's top edge and height, in pitch units. */
export function channelBounds(spec: BreadboardSpec): { top: number; height: number } {
  // Centred on the empty pitch between rows E and F.
  return { top: rowOffset(spec, 'E') + 0.55, height: 0.9 };
}

/** Total board height in pitch units, including margins. */
export function boardRows(spec: BreadboardSpec): number {
  return spec.powerRails ? 17 : 13;
}
