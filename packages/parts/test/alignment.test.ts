/**
 * Physical alignment: legs must sit exactly in the holes they are wired to.
 *
 * Reported from the app: parts appearing beside their holes rather than in them. The canvas draws
 * a part at its own coordinates and a hole at the board's, so if an example's coordinates disagree
 * with the board's layout the wire is electrically correct but visually wrong -- which reads as a
 * rendering bug and destroys trust in everything else on screen.
 *
 * These assertions compare the two independently computed positions, so the geometry cannot drift
 * from the netlist without failing here first.
 *
 * The distinction that matters: a *through-hole part* wired to a hole has its leg physically in
 * that hole, so the coordinates must coincide exactly. A *board* wired to a hole is connected by a
 * jumper wire spanning whatever distance separates them, and demanding they coincide would be
 * nonsense -- the whole point of a jumper is that its ends are apart.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_ROWS,
  MINI_BREADBOARD,
  holeId,
  rowOffset,
  type BreadboardRow,
  type BreadboardSpec,
} from '@robo-journey/sim-core';
import {
  LIBRARY_PROJECTS,
  PITCH_MM,
  partDefinition,
  splitTerminal,
  type Project,
} from '../src/index.js';

/** Absolute position of a breadboard hole, mirroring the canvas geometry. */
function holePosition(
  origin: { x: number; y: number },
  spec: BreadboardSpec,
  column: number,
  row: BreadboardRow,
): { x: number; y: number } {
  return {
    x: origin.x + column * PITCH_MM,
    y: origin.y + rowOffset(spec, row) * PITCH_MM,
  };
}

/** Parse `12A` into its column and row. */
function parseHole(name: string): { column: number; row: BreadboardRow } | null {
  const match = /^(\d+)([A-J])$/.exec(name);
  if (!match) return null;
  return { column: Number(match[1]), row: match[2] as BreadboardRow };
}

/**
 * Categories whose connection to a breadboard is a wire rather than a leg.
 *
 * Boards and instruments both sit next to the breadboard and reach into it, so their pins are
 * meant to be nowhere near the hole they are wired to.
 */
const reachesByLead = (category: string): boolean =>
  category === 'board' || category === 'instrument';

describe.each(LIBRARY_PROJECTS.map((e) => [e.name, e] as const))('%s', (_name, example) => {
  const project: Project = example.build();

  it('places every leg exactly in the hole it is wired to', () => {
    const boards = new Map(
      project.parts
        .map((part) => [part, safeDefinition(part.type)] as const)
        .filter(([, definition]) => definition?.internalSpec)
        .map(([part, definition]) => [part.id, { part, spec: definition!.internalSpec! }]),
    );

    let checked = 0;

    for (const wire of project.wires) {
      for (const [end, other] of [
        [wire.from, wire.to],
        [wire.to, wire.from],
      ] as const) {
        const { partId, pin } = splitTerminal(end);
        const board = boards.get(partId);
        if (!board) continue;

        const hole = parseHole(pin);
        if (!hole) continue;

        // The other end is a part pin; find where the canvas draws it.
        const { partId: otherId, pin: otherPin } = splitTerminal(other);
        const otherPart = project.parts.find((p) => p.id === otherId);
        const otherDefinition = otherPart ? safeDefinition(otherPart.type) : null;
        if (!otherPart || !otherDefinition) continue;
        // Only through-hole parts sit *in* holes. Anything in the `board` category -- an Uno, a
        // second breadboard -- reaches a hole by jumper wire, and its pin is meant to be far away.
        // Instruments are the same case for a different reason: a probe is a lead you run to a
        // point, so a meter wired to a hole is measuring it, not plugged into it.
        if (reachesByLead(otherDefinition.category)) continue;

        const pinSpec = otherDefinition.pins.find((p) => p.name === otherPin);
        if (!pinSpec) continue;

        const legAt = { x: otherPart.x + pinSpec.x, y: otherPart.y + pinSpec.y };
        const holeAt = holePosition(
          { x: board.part.x, y: board.part.y },
          board.spec,
          hole.column,
          hole.row,
        );

        expect(legAt.x, `${other} x should match ${end}`).toBeCloseTo(holeAt.x, 6);
        expect(legAt.y, `${other} y should match ${end}`).toBeCloseTo(holeAt.y, 6);
        checked += 1;
      }
    }

    // Guard against the test silently passing because it checked nothing -- but only when there
    // is something to check. An example with no breadboard (the serial one is just an Uno) has no
    // legs in holes by construction, and demanding otherwise would force every future example to
    // carry a breadboard it does not need.
    const hasPluggableParts =
      boards.size > 0 &&
      project.parts.some((part) => {
        const category = safeDefinition(part.type)?.category;
        return category !== undefined && !reachesByLead(category);
      });
    if (hasPluggableParts) expect(checked).toBeGreaterThan(0);
  });

  it('keeps every leg within the board it is plugged into', () => {
    for (const part of project.parts) {
      const definition = safeDefinition(part.type);
      if (!definition?.internalSpec) continue;

      const spec = definition.internalSpec;
      const maxX = part.x + (spec.columns + 2) * PITCH_MM;
      const maxY = part.y + (spec.powerRails ? 17 : 13) * PITCH_MM;

      for (const other of project.parts) {
        const otherDefinition = safeDefinition(other.type);
        // Same reasoning: only parts that physically sit on the board must fit within it.
        if (!otherDefinition || reachesByLead(otherDefinition.category)) continue;
        const pluggedIn = project.wires.some(
          (w) =>
            (w.from.startsWith(`${other.id}:`) && w.to.startsWith(`${part.id}:`)) ||
            (w.to.startsWith(`${other.id}:`) && w.from.startsWith(`${part.id}:`)),
        );
        if (!pluggedIn) continue;

        for (const pin of otherDefinition.pins) {
          const x = other.x + pin.x;
          const y = other.y + pin.y;
          expect(x, `${other.id}:${pin.name} runs off the right of ${part.id}`).toBeLessThanOrEqual(maxX);
          expect(y, `${other.id}:${pin.name} runs off the bottom of ${part.id}`).toBeLessThanOrEqual(maxY);
          expect(x).toBeGreaterThanOrEqual(part.x);
          expect(y).toBeGreaterThanOrEqual(part.y);
        }
      }
    }
  });

  it('references only columns the board actually has', () => {
    for (const part of project.parts) {
      const definition = safeDefinition(part.type);
      if (!definition?.internalSpec) continue;

      for (const wire of [...project.wires.map((w) => w.from), ...project.wires.map((w) => w.to)]) {
        if (!wire.startsWith(`${part.id}:`)) continue;
        const hole = parseHole(splitTerminal(wire).pin);
        if (!hole) continue;
        expect(hole.column, `${wire} exceeds the board's ${definition.internalSpec.columns} columns`)
          .toBeLessThanOrEqual(definition.internalSpec.columns);
        expect(hole.column).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe('board layout', () => {
  it('spaces mini-board holes exactly one pitch apart', () => {
    const origin = { x: 0, y: 0 };
    for (let column = 1; column < MINI_BREADBOARD.columns; column++) {
      const a = holePosition(origin, MINI_BREADBOARD, column, 'A');
      const b = holePosition(origin, MINI_BREADBOARD, column + 1, 'A');
      expect(b.x - a.x).toBeCloseTo(PITCH_MM, 9);
    }
    for (let i = 1; i < ALL_ROWS.length; i++) {
      const previous = ALL_ROWS[i - 1]!;
      const row = ALL_ROWS[i]!;
      const gap =
        holePosition(origin, MINI_BREADBOARD, 1, row).y -
        holePosition(origin, MINI_BREADBOARD, 1, previous).y;
      // One pitch within a half, two across the channel.
      expect([PITCH_MM, 2 * PITCH_MM]).toContainEqual(Number(gap.toFixed(9)));
    }
  });

  it('gives a resistor a 0.4 inch span, which is four holes', () => {
    const resistor = partDefinition('resistor');
    const a = resistor.pins.find((p) => p.name === 'a')!;
    const b = resistor.pins.find((p) => p.name === 'b')!;
    expect(b.x - a.x).toBeCloseTo(4 * PITCH_MM, 9);
  });

  it('gives an LED a 0.1 inch span, which is one hole', () => {
    const led = partDefinition('led');
    const anode = led.pins.find((p) => p.name === 'anode')!;
    const cathode = led.pins.find((p) => p.name === 'cathode')!;
    expect(cathode.x - anode.x).toBeCloseTo(PITCH_MM, 9);
  });

  it('spaces every Uno header pin on the 0.1 inch pitch', () => {
    const uno = partDefinition('arduino-uno');
    const top = uno.pins.filter((p) => p.y < 10).map((p) => p.x).sort((a, b) => a - b);
    for (let i = 1; i < top.length; i++) {
      const gap = top[i]! - top[i - 1]!;
      // 2.54 within a bank, 3.81 across the jog between D7 and D8.
      expect(gap === 0 || Math.abs(gap - PITCH_MM) < 1e-6 || Math.abs(gap - 3.81) < 1e-6).toBe(true);
    }
  });
});

function safeDefinition(type: string) {
  try {
    return partDefinition(type);
  } catch {
    return null;
  }
}
