/**
 * Local autosave.
 *
 * The first and most important layer of persistence: a refresh must never lose work, and that
 * should be true before anyone has signed in. An account syncs projects across machines; this
 * makes the current one survive a reload, a crash, or a closed tab.
 *
 * Deliberately independent of the account layer. If the server is down, or the user never signs
 * in, their circuit is still there when they come back.
 */
import { parseProject, type Project } from '@robo-journey/parts';

const STORAGE_KEY = 'robo-journey:workspace';
/** Bumped when the stored shape changes incompatibly. */
const STORAGE_VERSION = 1;

interface StoredWorkspace {
  version: number;
  savedAt: string;
  project: unknown;
}

/**
 * How long to wait after the last edit before writing.
 *
 * Long enough that dragging a part or typing a line does not write on every frame, short enough
 * that an accidental close loses at most a moment's work.
 */
export const AUTOSAVE_DELAY_MS = 600;

/** Save the project. Never throws: failing to autosave must not break the editor. */
export function saveWorkspace(project: Project): boolean {
  try {
    const payload: StoredWorkspace = {
      version: STORAGE_VERSION,
      savedAt: new Date().toISOString(),
      project,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    // Quota exceeded, or storage disabled in a private window. Losing autosave is bad; taking the
    // app down with it would be worse.
    return false;
  }
}

export interface RestoredWorkspace {
  readonly project: Project;
  readonly savedAt: Date | null;
}

/**
 * Restore the last autosaved project, or null if there is none.
 *
 * A stored project that no longer validates is discarded rather than repaired. Silently loading
 * half a document would be worse than starting fresh, because the user would not know which half.
 */
export function restoreWorkspace(): RestoredWorkspace | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const stored = JSON.parse(raw) as StoredWorkspace;
    if (stored.version !== STORAGE_VERSION) return null;

    return {
      project: parseProject(stored.project),
      savedAt: stored.savedAt ? new Date(stored.savedAt) : null,
    };
  } catch {
    // Corrupt or from an incompatible build. Clear it so the failure does not repeat every load.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing further to do.
    }
    return null;
  }
}

export function clearWorkspace(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing further to do.
  }
}
