/**
 * Canvas geometry, in millimetres.
 *
 * Everything is laid out in real units on the 2.54 mm (0.1") pitch that breadboards and through-
 * hole parts actually use, and converted to pixels once at render time. That is why a resistor
 * bent to a 0.4" span lands four holes apart -- the arithmetic says so, rather than a pixel offset
 * having been nudged until it looked right.
 */
import {
  ALL_ROWS,
  HALF_SIZE_BREADBOARD,
  holeId,
  railHoleId,
  railOffset,
  rowOffset,
  type BreadboardSpec,
} from '@robo-journey/sim-core';
import { PITCH_MM, partDefinition, terminalId, type Project } from '@robo-journey/parts';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Columns start one pitch in from the left edge. */
const COLUMN_X = (column: number): number => column * PITCH_MM;

/** Where a breadboard's holes sit relative to the board's origin. */
export function breadboardHolePositions(
  boardId: string,
  origin: Point,
  spec: BreadboardSpec = HALF_SIZE_BREADBOARD,
): Map<string, Point> {
  const positions = new Map<string, Point>();

  for (let column = 1; column <= spec.columns; column++) {
    for (const row of ALL_ROWS) {
      positions.set(holeId(boardId, column, row), {
        x: origin.x + COLUMN_X(column),
        y: origin.y + rowOffset(spec, row) * PITCH_MM,
      });
    }
  }

  if (spec.powerRails) {
    for (const side of ['top', 'bottom'] as const) {
      for (const polarity of ['positive', 'negative'] as const) {
        const offset = railOffset(spec, side, polarity);
        if (offset === null) continue;
        for (let column = 1; column <= spec.columns; column++) {
          positions.set(railHoleId(boardId, side, polarity, column), {
            x: origin.x + COLUMN_X(column),
            y: origin.y + offset * PITCH_MM,
          });
        }
      }
    }
  }

  return positions;
}

/** Rotate a point about the origin by degrees. */
function rotate(point: Point, degrees: number): Point {
  if (!degrees) return point;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

/**
 * Absolute position of every terminal in the project.
 *
 * One map serves wire rendering, hit testing and hole snapping, so those three can never disagree
 * about where a pin is.
 */
export function terminalPositions(project: Project): Map<string, Point> {
  const positions = new Map<string, Point>();

  for (const part of project.parts) {
    let definition;
    try {
      definition = partDefinition(part.type);
    } catch {
      continue;
    }

    if (definition.internalSpec) {
      for (const [hole, point] of breadboardHolePositions(
        part.id,
        { x: part.x, y: part.y },
        definition.internalSpec,
      )) {
        positions.set(hole, point);
      }
    }

    // About the middle of the body, not the corner: a part turned about its corner swings away
    // across the workspace instead of spinning where it sits, and lining it back up by hand after
    // every quarter turn is not a feature. The canvas applies the same centre, which is what keeps
    // wires on the legs they are attached to.
    const centre = { x: definition.width / 2, y: definition.height / 2 };

    for (const pin of definition.pins) {
      const local = rotate({ x: pin.x - centre.x, y: pin.y - centre.y }, part.rotation);
      positions.set(terminalId(part.id, pin.name), {
        x: part.x + centre.x + local.x,
        y: part.y + centre.y + local.y,
      });
    }
  }

  return positions;
}

/** Squared distance, for comparisons that never need the square root. */
function distance2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Nearest breadboard hole to a point, within a tolerance.
 *
 * Half a pitch: close enough that a leg visibly over a hole snaps into it, far enough that a leg
 * placed between two holes stays where the user put it rather than silently joining a net they did
 * not intend.
 */
export const SNAP_TOLERANCE_MM = PITCH_MM / 2;

export function nearestHole(
  point: Point,
  holes: ReadonlyMap<string, Point>,
  tolerance = SNAP_TOLERANCE_MM,
): string | null {
  let best: string | null = null;
  let bestDistance = tolerance * tolerance;

  for (const [id, holePoint] of holes) {
    const d = distance2(point, holePoint);
    if (d <= bestDistance) {
      bestDistance = d;
      best = id;
    }
  }

  return best;
}

/** Every breadboard hole in the project, keyed by terminal id. */
export function allHoles(project: Project): Map<string, Point> {
  const holes = new Map<string, Point>();
  for (const part of project.parts) {
    let definition;
    try {
      definition = partDefinition(part.type);
    } catch {
      continue;
    }
    if (!definition.internalSpec) continue;
    for (const [hole, point] of breadboardHolePositions(
      part.id,
      { x: part.x, y: part.y },
      definition.internalSpec,
    )) {
      holes.set(hole, point);
    }
  }
  return holes;
}

/** Snap a millimetre coordinate to the nearest pitch multiple. */
export function snapToPitch(value: number): number {
  return Math.round(value / PITCH_MM) * PITCH_MM;
}
