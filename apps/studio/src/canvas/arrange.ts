/**
 * Lining parts up, and spacing them out.
 *
 * Everything here is arithmetic on bounding boxes, deliberately kept out of the store and the
 * canvas so it can be checked without either. A workspace people actually build on ends up
 * crooked, and nudging six parts into a row by hand is the kind of work a tool should do.
 *
 * Positions stay on the 2.54 mm grid. An aligned part that no longer plugs into a breadboard would
 * be tidier and useless -- see `packages/parts` on why the pitch is load-bearing.
 *
 * That costs exactness in one case. Aligning right edges when the parts are different widths puts
 * each left edge at `edge - width`, and a width that is not a whole number of holes lands between
 * two of them; snapping there leaves the edges up to half a hole apart. Half a hole is 1.27 mm and
 * invisible, an unpluggable part is not, so the grid wins. Aligning left or top edges is exact,
 * because every part's position is already on the grid.
 */
import { PITCH_MM, partDefinition, type PartInstance } from '@robo-journey/parts';

export type Arrangement =
  | 'left'
  | 'centre-x'
  | 'right'
  | 'top'
  | 'centre-y'
  | 'bottom'
  | 'space-x'
  | 'space-y';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Snap to the hole grid, which is where every part has to end up. */
const snap = (mm: number): number => Math.round(mm / PITCH_MM) * PITCH_MM;

/**
 * A part's footprint on the workspace.
 *
 * Rotation swaps the sides at a quarter turn, so a part stood on its end is measured as it looks
 * rather than as it was drawn. A part whose type is not registered still has to be arrangeable,
 * so an unknown one is treated as a point.
 */
export function boxOf(part: PartInstance): Box {
  let width = 0;
  let height = 0;
  try {
    const definition = partDefinition(part.type);
    width = definition.width;
    height = definition.height;
  } catch {
    // Unknown type: no footprint to speak of. Aligning it by its origin is still the right answer.
  }
  const quarter = Math.abs(Math.round(part.rotation / 90) % 2) === 1;
  return {
    x: part.x,
    y: part.y,
    width: quarter ? height : width,
    height: quarter ? width : height,
  };
}

/** The rectangle containing every box. */
export function boundsOf(boxes: readonly Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Where each part should move to, by id. Parts that do not move are left out.
 *
 * Fewer than two parts is not an arrangement, and the caller is expected to have disabled the
 * control rather than relying on this -- but it returns nothing rather than dividing by zero.
 */
export function arrange(
  parts: readonly PartInstance[],
  how: Arrangement,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (parts.length < 2) return out;

  const boxes = parts.map(boxOf);
  const bounds = boundsOf(boxes);

  /**
   * Move a part, snapping only what actually changed.
   *
   * Snapping a coordinate the operation was not touching is how "align left" silently shifts
   * everything vertically too, and how the part that *defined* the left edge gets nudged off the
   * holes it was plugged into. A coordinate handed back unchanged is left exactly alone, so the
   * reference part never moves and the other axis is never touched.
   *
   * The rest lands on the grid because it inherits an edge from a part that was already on it --
   * everything placed or dragged is snapped on drop. Centring and spacing compute genuinely new
   * numbers, and those are the ones that need rounding.
   */
  const place = (part: PartInstance, x: number, y: number) => {
    const at = { x: x === part.x ? x : snap(x), y: y === part.y ? y : snap(y) };
    if (at.x !== part.x || at.y !== part.y) out.set(part.id, at);
  };

  if (how === 'space-x' || how === 'space-y') {
    const horizontal = how === 'space-x';
    // Ordered along the axis being spaced, so "evenly" means evenly as it looks rather than in
    // whatever order the parts happen to sit in the document.
    const order = parts
      .map((part, i) => ({ part, box: boxes[i]! }))
      .sort((a, b) => (horizontal ? a.box.x - b.box.x : a.box.y - b.box.y));

    // The two on the ends stay put and everything between shares what is left, which is what
    // makes the gaps equal rather than the positions equal.
    const span = horizontal ? bounds.width : bounds.height;
    const used = order.reduce((n, o) => n + (horizontal ? o.box.width : o.box.height), 0);
    const gap = (span - used) / (order.length - 1);

    let cursor = horizontal ? bounds.x : bounds.y;
    for (const { part, box } of order) {
      place(part, horizontal ? cursor : part.x, horizontal ? part.y : cursor);
      cursor += (horizontal ? box.width : box.height) + gap;
    }
    return out;
  }

  for (const [i, part] of parts.entries()) {
    const box = boxes[i]!;
    switch (how) {
      case 'left':
        place(part, bounds.x, part.y);
        break;
      case 'right':
        place(part, bounds.x + bounds.width - box.width, part.y);
        break;
      case 'centre-x':
        place(part, bounds.x + (bounds.width - box.width) / 2, part.y);
        break;
      case 'top':
        place(part, part.x, bounds.y);
        break;
      case 'bottom':
        place(part, part.x, bounds.y + bounds.height - box.height);
        break;
      case 'centre-y':
        place(part, part.x, bounds.y + (bounds.height - box.height) / 2);
        break;
    }
  }
  return out;
}
