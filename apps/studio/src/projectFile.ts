/**
 * Reading and writing `.rjp` project files.
 *
 * Plain JSON, validated on the way in. Terminals are named after the labels printed on the
 * hardware (`uno1:D13`, `bb1:12A`), so a project file diffs legibly and a merge conflict is
 * something a human can actually resolve.
 *
 * Saving goes through a Blob download rather than the File System Access API: the latter is
 * Chromium-only, and a simulator that silently cannot save in Firefox would be worse than one that
 * always saves to the downloads folder.
 */
import { parseProject, type Project } from '@robo-journey/parts';

export const PROJECT_EXTENSION = '.rjp';

/** Turn a project into the bytes that go in the file. */
export function serializeProject(project: Project): string {
  // Two-space indent and a trailing newline: this is a file people will read and diff.
  return `${JSON.stringify(project, null, 2)}\n`;
}

/** Parse a project file, throwing a readable error rather than a schema dump. */
export function deserializeProject(text: string): Project {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON, so it is not a robo-journey project.');
  }

  try {
    return parseProject(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new Error(`That project file could not be read: ${detail}`);
  }
}

/** A filename safe on every platform, derived from the project's own name. */
export function projectFilename(project: Project): string {
  const base = project.name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `${base}${PROJECT_EXTENSION}`;
}

/** Save a project to the user's downloads. */
export function downloadProject(project: Project): void {
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = projectFilename(project);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  // Revoking immediately can cancel the download in some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Prompt for a project file and read it. Resolves to null if the user cancels. */
export function openProjectFile(): Promise<Project | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${PROJECT_EXTENSION},application/json`;

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file
        .text()
        .then((text) => resolve(deserializeProject(text)))
        .catch(reject);
    });

    // A cancelled picker fires no event in most browsers, so nothing resolves and the promise is
    // simply dropped -- which is the correct outcome for "the user changed their mind".
    input.click();
  });
}
