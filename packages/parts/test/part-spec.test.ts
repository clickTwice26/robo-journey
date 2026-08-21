/**
 * The facts a hover card shows.
 *
 * The card is DOM and the definition is data, so this covers the half that decides whether the
 * card is worth opening: a part whose manifest says what it is, what will kill it and what the
 * model leaves out should carry all three onto its definition, because that is the only route the
 * palette has to reach them.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MANIFESTS,
  allParts,
  installBuiltinManifests,
  manifestToPartDefinition,
  partDefinition,
} from '../src/index.js';

installBuiltinManifests();

describe('part spec', () => {
  it('carries the datasheet facts from the manifest onto the definition', () => {
    const definition = partDefinition('vibration-sensor');
    expect(definition.spec?.description).toMatch(/vibration switch/i);
    expect(definition.spec?.partNumber).toBe('SW-420');
    expect(definition.spec?.limits).toMatchObject({
      vccMaxVolts: 5.5,
      vccMinVolts: 3.3,
      pinMaxAmps: 0.02,
    });
    // What the model does not capture, which is the thing worth reading before trusting a reading.
    expect(definition.spec?.notes?.[0]).toMatch(/ragged/);
  });

  it('gives every built-in part something to say', () => {
    for (const manifest of BUILTIN_MANIFESTS) {
      const definition = partDefinition(manifest.id);
      expect(definition.spec?.description, `${manifest.id} has no description`).toBeTruthy();
      expect(definition.spec?.limits, `${manifest.id} has no limits`).toBeDefined();
    }
  });

  it('leaves out the fields a manifest did not fill in, rather than showing blanks', () => {
    const bare = manifestToPartDefinition({
      ...BUILTIN_MANIFESTS[0]!,
      id: 'bare-part',
      manufacturer: '',
      partNumber: '',
      description: '',
      provenance: { source: 'builtin', unresolved: [], verified: true },
    });
    expect(bare.spec).not.toHaveProperty('description');
    expect(bare.spec).not.toHaveProperty('manufacturer');
    expect(bare.spec).not.toHaveProperty('partNumber');
    expect(bare.spec).not.toHaveProperty('notes');
  });

  it('does not put a spec on the parts that are not manifests', () => {
    // The Uno, the breadboards and the stimuli are built by hand: no datasheet, nothing to show.
    for (const type of ['arduino-uno', 'breadboard-mini', 'stim-heat']) {
      expect(partDefinition(type).spec, type).toBeUndefined();
    }
  });

  it('leaves every part in the palette renderable, spec or not', () => {
    // The card reads these unconditionally, so a missing one would be a crash on hover.
    for (const part of allParts()) {
      expect(typeof part.label).toBe('string');
      expect(Array.isArray(part.pins)).toBe(true);
      expect(Number.isFinite(part.width) && Number.isFinite(part.height)).toBe(true);
    }
  });
});
