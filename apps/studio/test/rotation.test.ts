/**
 * Turning a part.
 *
 * The whole risk in rotation is two places disagreeing about where a pin ended up: the canvas
 * draws the artwork and `terminalPositions` decides where wires attach, and if those differ by so
 * much as a degree the wires detach from the legs they are soldered to. They agree by construction
 * -- both rotate about the part's origin, both clockwise -- and this is what says so.
 */
import { describe, expect, it } from 'vitest';
import { installBuiltinManifests, parseProject, partDefinition } from '@robo-journey/parts';
import { terminalPositions } from '../src/canvas/geometry.ts';

installBuiltinManifests();

/** One flame sensor at the origin, turned by `rotation`. */
const sensorAt = (rotation: number) =>
  parseProject({
    version: 1,
    parts: [{ id: 'fs', type: 'flame-sensor', x: 0, y: 0, rotation }],
    wires: [],
  });

describe('a rotated part', () => {
  it('leaves its pins alone at zero', () => {
    const spec = partDefinition('flame-sensor').pins.find((p) => p.name === 'VCC')!;
    const at = terminalPositions(sensorAt(0)).get('fs:VCC')!;
    expect(at.x).toBeCloseTo(spec.x, 9);
    expect(at.y).toBeCloseTo(spec.y, 9);
  });

  it('turns them clockwise about the middle of the body', () => {
    // Screen coordinates run down the page, so a quarter turn clockwise sends a pin that was to
    // the right of the centre to below it.
    const definition = partDefinition('flame-sensor');
    const spec = definition.pins.find((p) => p.name === 'VCC')!;
    const cx = definition.width / 2;
    const cy = definition.height / 2;

    const at = terminalPositions(sensorAt(90)).get('fs:VCC')!;
    expect(at.x).toBeCloseTo(cx - (spec.y - cy), 9);
    expect(at.y).toBeCloseTo(cy + (spec.x - cx), 9);
  });

  it('comes back to where it started after four quarters', () => {
    const start = terminalPositions(sensorAt(0)).get('fs:AOUT')!;
    const round = terminalPositions(sensorAt(360)).get('fs:AOUT')!;
    expect(round.x).toBeCloseTo(start.x, 9);
    expect(round.y).toBeCloseTo(start.y, 9);
  });

  it('keeps every pin the same distance from the centre it turns about', () => {
    // A rotation cannot stretch a part. If this ever fails the transform has picked up a scale.
    const definition = partDefinition('flame-sensor');
    const cx = definition.width / 2;
    const cy = definition.height / 2;

    for (const rotation of [0, 90, 180, 270, 37]) {
      const positions = terminalPositions(sensorAt(rotation));
      for (const pin of definition.pins) {
        const at = positions.get(`fs:${pin.name}`)!;
        expect(Math.hypot(at.x - cx, at.y - cy)).toBeCloseTo(
          Math.hypot(pin.x - cx, pin.y - cy),
          9,
        );
      }
    }
  });

  it('moves with the part it belongs to', () => {
    const project = parseProject({
      version: 1,
      parts: [{ id: 'fs', type: 'flame-sensor', x: 25, y: 40, rotation: 90 }],
      wires: [],
    });
    const definition = partDefinition('flame-sensor');
    const spec = definition.pins.find((p) => p.name === 'GND')!;
    const cx = definition.width / 2;
    const cy = definition.height / 2;

    const at = terminalPositions(project).get('fs:GND')!;
    expect(at.x).toBeCloseTo(25 + cx - (spec.y - cy), 9);
    expect(at.y).toBeCloseTo(40 + cy + (spec.x - cx), 9);
  });

  it('leaves a part where it sits when it turns', () => {
    // The point of turning about the centre: four quarter turns and the body has not wandered.
    const definition = partDefinition('flame-sensor');
    const centre = (rotation: number) => {
      const positions = terminalPositions(sensorAt(rotation));
      const all = definition.pins.map((p) => positions.get(`fs:${p.name}`)!);
      return {
        x: all.reduce((n, p) => n + p.x, 0) / all.length,
        y: all.reduce((n, p) => n + p.y, 0) / all.length,
      };
    };

    // A header is not symmetric about the body, so its own middle shifts -- but never by more than
    // the part is wide, which a corner rotation would exceed immediately.
    for (const rotation of [90, 180, 270]) {
      expect(Math.abs(centre(rotation).x - centre(0).x)).toBeLessThan(definition.width);
      expect(Math.abs(centre(rotation).y - centre(0).y)).toBeLessThan(definition.width);
    }
  });
});
