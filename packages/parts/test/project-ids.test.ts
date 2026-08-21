/**
 * Part ids have to be unique, and nothing was making sure they were.
 *
 * The symptom was not a crash. Place a heat source into a workspace restored from the last
 * session and the sensor you added just before it stops responding -- because the id counter
 * restarts at zero on every page load, so it eventually hands out an id the restored document
 * already contains. The builder keys devices by part id and keeps the first, so the second part
 * gets no device at all and its state variable is written into somebody else's.
 *
 * These tests cover both halves: that a duplicate really does cost a part its device, and that
 * neither the loader nor the id generator produces one any more.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCircuit,
  installBuiltinManifests,
  parseProject,
  withUniqueIds,
  type Project,
} from '../src/index.js';

installBuiltinManifests();

const blinkHex = readFileSync(
  fileURLToPath(new URL('../../sim-core/test/fixtures/blink.hex', import.meta.url)),
  'utf8',
);

/** Just enough of a circuit to build: two sensors, wired to nothing in particular. */
function twoSensors(secondId: string): Project {
  return {
    version: 1,
    name: 'Two sensors',
    parts: [
      { id: 'uno1', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} },
      { id: 'tm1', type: 'tmp36', x: 20, y: 40, rotation: 0, props: {} },
      { id: secondId, type: 'soil-moisture', x: 60, y: 40, rotation: 0, props: {} },
    ],
    wires: [],
    sketch: [],
    assertions: [],
  };
}

const progMem = () => new Uint16Array(0x8000);

describe('duplicate part ids', () => {
  it('costs the second part its device, which is why they must not happen', () => {
    // Built from the object directly, bypassing the loader's repair, to show the damage itself.
    // The Uno is the board rather than a device, so two sensors should mean two entries.
    const healthy = buildCircuit(twoSensors('sm1'), { progMem: progMem() });
    expect([...healthy.devices.keys()].sort()).toEqual(['sm1', 'tm1']);

    const clash = buildCircuit(twoSensors('tm1'), { progMem: progMem() });

    // One device for two sensors: the builder keeps the first part to claim the id. Anything
    // written to `tm1` now lands on the TMP36, and the soil sensor is not addressable at all --
    // it sits on the workspace reading nothing, which is what the report described.
    expect([...clash.devices.keys()]).toEqual(['tm1']);
  });
});

describe('withUniqueIds', () => {
  it('leaves a sound document untouched', () => {
    const project = parseProject(twoSensors('sm1'));
    expect(withUniqueIds(project)).toEqual(project);
  });

  it('renames the later of two parts sharing an id', () => {
    const repaired = withUniqueIds(parseProject(twoSensors('spare')) as never);
    expect(repaired.parts.map((p) => p.id)).toEqual(['uno1', 'tm1', 'spare']);

    const clashing = withUniqueIds({
      ...parseProject(twoSensors('spare')),
      parts: twoSensors('tm1').parts.map((p) => ({ ...p, rotation: 0, props: {} })),
    });
    // The original keeps its id -- and with it every wire, since a terminal is `<partId>:<pin>`
    // and the two are indistinguishable from the wire's side.
    expect(clashing.parts.map((p) => p.id)).toEqual(['uno1', 'tm1', 'tm1-2']);
  });

  it('keeps renaming until it finds a free id', () => {
    const repaired = withUniqueIds({
      ...parseProject({ version: 1, parts: [], wires: [] }),
      parts: ['st1', 'st1', 'st1-2', 'st1'].map((id, i) => ({
        id,
        type: 'stim-heat',
        x: i * 10,
        y: 0,
        rotation: 0,
        props: {},
      })),
    });
    expect(repaired.parts.map((p) => p.id)).toEqual(['st1', 'st1-2', 'st1-2-2', 'st1-3']);
  });

  it('treats wire ids as part of the same namespace, because the generator does', () => {
    const repaired = withUniqueIds({
      ...parseProject({ version: 1, parts: [], wires: [] }),
      parts: [{ id: 'w1', type: 'stim-heat', x: 0, y: 0, rotation: 0, props: {} }],
      wires: [{ id: 'w1', from: 'uno1:D13', to: 'uno1:GND', color: '#c0392b' }],
    });
    expect(repaired.parts[0]!.id).toBe('w1');
    expect(repaired.wires[0]!.id).toBe('w1-2');
  });

  it('is applied by parseProject, so every load path is covered', () => {
    const loaded = parseProject({
      version: 1,
      parts: [
        { id: 'st1', type: 'stim-heat', x: 0, y: 0 },
        { id: 'st1', type: 'stim-lamp', x: 20, y: 0 },
      ],
      wires: [],
    });
    expect(loaded.parts.map((p) => p.id)).toEqual(['st1', 'st1-2']);
  });
});
