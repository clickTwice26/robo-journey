/**
 * Diagnostic parsing runs against captured avr-gcc stderr, so it needs neither Docker nor a
 * toolchain. These are the strings Monaco will draw squiggles from.
 */
import { describe, expect, it } from 'vitest';
import { hasErrors, parseDiagnostics } from '../src/index.js';

const REAL_STDERR =
  "/sketch/sketch/sketch.ino: In function 'void setup()':\n" +
  "/sketch/sketch/sketch.ino:2:11: error: 'undefinedThing' was not declared in this scope\n" +
  '   int x = undefinedThing;\n' +
  '           ^~~~~~~~~~~~~~\n';

describe('parseDiagnostics', () => {
  it('extracts file, line, column, severity and message', () => {
    const [diagnostic, ...rest] = parseDiagnostics(REAL_STDERR);
    expect(rest).toHaveLength(0);
    expect(diagnostic).toEqual({
      file: '/sketch/sketch/sketch.ino',
      line: 2,
      column: 11,
      severity: 'error',
      message: "'undefinedThing' was not declared in this scope",
    });
  });

  it('strips the container path prefix so the editor sees sketch-relative names', () => {
    const [diagnostic] = parseDiagnostics(REAL_STDERR, '/sketch/sketch');
    expect(diagnostic?.file).toBe('sketch.ino');
  });

  it('drops caret lines and source echoes rather than inventing markers', () => {
    // Three of the four input lines are context, not diagnostics.
    expect(parseDiagnostics(REAL_STDERR)).toHaveLength(1);
  });

  it('handles a diagnostic with no column', () => {
    const [diagnostic] = parseDiagnostics('/s/a.ino:7: warning: unused variable\n');
    expect(diagnostic?.line).toBe(7);
    expect(diagnostic?.column).toBeUndefined();
    expect(diagnostic?.severity).toBe('warning');
  });

  it('treats "fatal error" as an error', () => {
    const [diagnostic] = parseDiagnostics("/s/a.ino:1:10: fatal error: Nope.h: No such file\n");
    expect(diagnostic?.severity).toBe('error');
    expect(hasErrors(parseDiagnostics("/s/a.ino:1:10: fatal error: Nope.h: No such file\n"))).toBe(true);
  });

  it('separates warnings from errors', () => {
    const diagnostics = parseDiagnostics(
      '/s/a.ino:3:1: warning: unused variable\n/s/a.ino:9:2: note: declared here\n',
    );
    expect(diagnostics.map((d) => d.severity)).toEqual(['warning', 'note']);
    expect(hasErrors(diagnostics)).toBe(false);
  });

  it('returns nothing for clean output', () => {
    expect(parseDiagnostics('')).toEqual([]);
    expect(parseDiagnostics('Sketch uses 924 bytes (2%) of program storage space.\n')).toEqual([]);
  });
});
