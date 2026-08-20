/**
 * The component library: manifests that are not compiled into the app.
 *
 * There are two registries to keep in step and it is easy to notice only one of them. The UI
 * thread's registry feeds the palette and the canvas; the worker keeps its own, because a Web
 * Worker is a separate module graph with separate module state. A manifest registered only on the
 * UI side produces a part that can be placed and wired and drawn, and then reports "unknown part
 * type" the moment it is simulated -- which looks like a simulator bug rather than a missing
 * registration.
 *
 * So every manifest goes through here, and here registers it in both places and stores it. Nothing
 * else should call `registerPart` for a manifest.
 *
 * Built-ins are handled differently on purpose: the worker installs those itself at module load,
 * so they are present before any message could arrive and cannot be lost to an ordering mistake.
 */
import {
  installBuiltinManifests,
  manifestToPartDefinition,
  parseManifest,
  registerPart,
  type ComponentManifest,
} from '@robo-journey/parts';
import type { SimApi } from './sim/protocol.ts';

const STORAGE_KEY = 'robo-journey:library';
const STORAGE_VERSION = 1;

interface StoredLibrary {
  version: number;
  manifests: unknown[];
}

/** Parts compiled in, registered on the UI thread. Idempotent. */
installBuiltinManifests();

function read(): ComponentManifest[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  try {
    const stored = JSON.parse(raw) as StoredLibrary;
    if (stored.version !== STORAGE_VERSION) return [];
    // Parsed individually: one manifest from an incompatible build should cost that manifest, not
    // the whole library.
    return stored.manifests.flatMap((entry) => {
      try {
        return [parseManifest(entry)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function write(manifests: readonly ComponentManifest[]): void {
  try {
    const payload: StoredLibrary = { version: STORAGE_VERSION, manifests: [...manifests] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded or storage disabled. Losing the library is bad; taking the app down is worse.
  }
}

/** Manifests the user has added, in the order they were added. */
export function storedManifests(): ComponentManifest[] {
  return read();
}

/**
 * Restore the stored library into both registries.
 *
 * Call once, before the first project is loaded. Comlink preserves call order over the port, so
 * the worker sees every manifest before the `load` that needs them.
 */
export function restoreLibrary(sim: Pick<SimApi, 'registerManifest'>): ComponentManifest[] {
  const manifests = read();
  for (const manifest of manifests) {
    try {
      registerPart(manifestToPartDefinition(manifest));
    } catch {
      // Already registered, or shadowing a built-in. Either way the worker still needs it.
    }
    void sim.registerManifest(manifest);
  }
  return manifests;
}

/**
 * Add a manifest to the library.
 *
 * Registers it on both sides and stores it, so the part survives a reload -- a component someone
 * spent an extraction on should not have to be extracted again.
 */
export function addManifest(
  sim: Pick<SimApi, 'registerManifest'>,
  manifest: ComponentManifest,
): void {
  registerPart(manifestToPartDefinition(manifest));
  void sim.registerManifest(manifest);

  const existing = read().filter((m) => m.id !== manifest.id);
  write([...existing, manifest]);
}

/** Forget a stored manifest. The registries keep it until the next reload. */
export function forgetManifest(id: string): void {
  write(read().filter((m) => m.id !== id));
}
