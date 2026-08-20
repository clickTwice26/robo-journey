/**
 * Every project in the library, built.
 *
 * `alignment.test.ts` proves the legs are in the right holes. This proves the circuit those holes
 * describe can actually be built and run -- a project referencing a part that no longer exists, or
 * wiring a bus device with no bus, is a broken example that looks perfect on the canvas and fails
 * the moment somebody presses Run.
 *
 * It is a small suite for the amount it covers: twenty-odd circuits, each exercising whatever
 * archetypes it happens to use, checked on every commit for the price of one file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHex } from '@robo-journey/sim-core';
import {
  BUILTIN_MANIFESTS,
  LIBRARY,
  LIBRARY_PROJECTS,
  buildCircuit,
  installBuiltinManifests,
  libraryProject,
  unregisterPart,
} from '../src/index.js';

const blink = () =>
  loadHex(
    readFileSync(
      fileURLToPath(new URL('../../sim-core/test/fixtures/blink.hex', import.meta.url)),
      'utf8',
    ),
  );

afterEach(() => {
  for (const manifest of BUILTIN_MANIFESTS) unregisterPart(manifest.id);
});

describe('the library', () => {
  it('gives every project a unique id', () => {
    const ids = LIBRARY_PROJECTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('puts every project in exactly one group', () => {
    const counted = LIBRARY.flatMap((g) => g.projects).length;
    expect(counted).toBe(LIBRARY_PROJECTS.length);
  });

  it('has no empty groups', () => {
    for (const group of LIBRARY) expect(group.projects.length).toBeGreaterThan(0);
  });

  it('finds a project by id', () => {
    expect(libraryProject('blink')?.name).toBe('Blink an LED');
    expect(libraryProject('nothing-like-this')).toBeUndefined();
  });

  it('describes every project, because the description is how anyone chooses one', () => {
    for (const project of LIBRARY_PROJECTS) {
      expect(project.description.length).toBeGreaterThan(20);
      expect(project.name.length).toBeGreaterThan(3);
    }
  });
});

describe.each(LIBRARY_PROJECTS.map((p) => [p.name, p] as const))('%s', (_name, project) => {
  it('builds a circuit with nothing unaccounted for', () => {
    installBuiltinManifests();
    const built = buildCircuit(project.build(), { progMem: blink() });
    expect(built.problems).toEqual([]);
  });

  it('runs without the solver falling over', () => {
    // Ten milliseconds is enough to reach an operating point and take a few timesteps, which is
    // where a circuit that cannot converge gives itself away.
    installBuiltinManifests();
    const built = buildCircuit(project.build(), { progMem: blink() });
    expect(() => built.board.runFor(0.01)).not.toThrow();
  });

  it('ships a sketch', () => {
    const built = project.build();
    expect(built.sketch.length).toBeGreaterThan(0);
    expect(built.sketch[0]!.contents).toContain('void setup()');
  });
});
