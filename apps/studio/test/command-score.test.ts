/**
 * Ranking in the command palette.
 *
 * Written because the first version of the comment above `score` claimed "bar" would find
 * "Build & Run". It does not -- there is no r after the a -- and nobody would have noticed until
 * they typed it. A ranking function is exactly the kind of thing that looks right in a screenshot
 * and is wrong in the third case you try.
 */
import { describe, expect, it } from 'vitest';
import { score } from '../src/panels/CommandPalette.tsx';

/** Best match first, the way the palette sorts. */
const rank = (needle: string, ...labels: string[]) =>
  labels
    .map((label) => ({ label, points: score(label, needle) }))
    .filter((entry) => entry.points > 0)
    .sort((a, b) => b.points - a.points)
    .map((entry) => entry.label);

describe('score', () => {
  it('matches a subsequence, not just a substring', () => {
    expect(score('Build & Run', 'bru')).toBeGreaterThan(0);
    expect(score('Build & Run', 'brn')).toBeGreaterThan(0);
    // Order matters: the letters have to appear in the order typed.
    expect(score('Build & Run', 'rub')).toBe(0);
  });

  it('rejects a letter that is not there', () => {
    expect(score('Compile', 'compz')).toBe(0);
  });

  it('takes everything with an empty query, so the palette opens full', () => {
    expect(score('anything at all', '')).toBe(1);
  });

  it('prefers a word start over the same letters mid-word', () => {
    // Both contain c, o, m in order. Only one starts a word with them.
    expect(rank('com', 'Compile', 'Reset all breakpoints com')[0]).toBe('Compile');
  });

  it('prefers a run of adjacent letters over the same letters scattered', () => {
    expect(score('Serial Monitor', 'seri')).toBeGreaterThan(score('Set resistance in it', 'seri'));
  });

  it('breaks ties toward the shorter label', () => {
    expect(score('Compile', 'compile')).toBeGreaterThan(score('Compile the whole thing', 'compile'));
  });

  it('ranks the obvious intent first for the queries people actually type', () => {
    const everything = [
      'Build & Run', 'Compile', 'Reset', 'New project', 'Save project', 'Open project…',
      'Zoom in', 'Zoom out', 'Fit circuit to view', 'Undo', 'Redo', 'Browse all…',
      'Keyboard shortcuts', 'Add LED', 'Add 10k Potentiometer',
    ];
    expect(rank('undo', ...everything)[0]).toBe('Undo');
    expect(rank('save', ...everything)[0]).toBe('Save project');
    expect(rank('zoomin', ...everything)[0]).toBe('Zoom in');
    expect(rank('led', ...everything)[0]).toBe('Add LED');
  });
});
