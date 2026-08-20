/**
 * Components that ship with the app, described the same way an extracted one is.
 *
 * Written as manifests rather than as hand-coded part definitions on purpose. Every one of these
 * goes through the identical path a datasheet extraction takes -- the same schema, the same
 * validator, the same runtime -- so the archetypes are exercised by the library itself rather than
 * only by whatever a user happens to feed the extractor. If a manifest cannot describe a 7805, the
 * tests say so before anyone tries it on a PDF.
 *
 * The numbers are datasheet-typical figures. Where a figure depends on something the datasheet
 * cannot know -- how much copper a regulator's tab is soldered to, above all -- the assumption is
 * recorded in `unresolved` rather than hidden in a default.
 *
 * **What is not here matters as much as what is.** A part earns a place only if the engine can
 * simulate something true about it. Parts on proprietary single-wire protocols -- DHT11, DHT22,
 * DS18B20, WS2812 -- have no archetype yet, and adding them as decoration would mean shipping
 * components that look right in the palette and do nothing on the canvas, which is the failure mode
 * this whole project exists to avoid. They arrive when the protocol does.
 */
import type { ComponentManifest } from './manifest.js';
import { manifestToPartDefinition } from './manifest-runtime.js';
import { registerPart, isRegistered } from './registry.js';

import { ACTUATORS } from './builtin/actuators.js';
import { BREAKOUTS } from './builtin/breakouts.js';
import { DISCRETES } from './builtin/discretes.js';
import { DISPLAYS } from './builtin/displays.js';
import { LOGIC } from './builtin/logic.js';
import { POWER } from './builtin/power.js';
import { SENSORS } from './builtin/sensors.js';

/** Every manifest compiled into the app. */
export const BUILTIN_MANIFESTS: readonly ComponentManifest[] = [
  ...DISCRETES,
  ...SENSORS,
  ...BREAKOUTS,
  ...DISPLAYS,
  ...ACTUATORS,
  ...POWER,
  ...LOGIC,
];

/**
 * Put the built-in manifests into the registry.
 *
 * Idempotent, because the studio calls it at start-up and the tests call it per suite.
 */
export function installBuiltinManifests(): void {
  for (const manifest of BUILTIN_MANIFESTS) {
    if (isRegistered(manifest.id)) continue;
    registerPart(manifestToPartDefinition(manifest));
  }
}
