/**
 * avr-gcc diagnostics -> structured markers.
 *
 * arduino-cli hands back raw compiler stderr. Monaco wants `{line, column, severity, message}` to
 * draw a squiggle, so this is the translation layer. Keeping it separate from the process plumbing
 * means it is testable against captured stderr without invoking Docker.
 */

export type DiagnosticSeverity = 'error' | 'warning' | 'note';

export interface Diagnostic {
  /** Source file the diagnostic refers to, as reported by the compiler. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column, when the compiler reported one. */
  readonly column?: number;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
}

// "/sketch/Bad/Bad.ino:2:11: error: 'undefinedThing' was not declared in this scope"
// The column group is optional: some diagnostics report only a line.
const GCC_DIAGNOSTIC = /^(.+?):(\d+)(?::(\d+))?:\s+(error|warning|note|fatal error):\s+(.*)$/;

/**
 * Parse compiler stderr into diagnostics.
 *
 * Unmatched lines (the source echo, the caret line, "In function 'void setup()':") are dropped
 * rather than surfaced as pseudo-diagnostics, which would put meaningless markers in the editor.
 */
export function parseDiagnostics(stderr: string, stripPrefix?: string): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const raw of stderr.split(/\r?\n/)) {
    const match = GCC_DIAGNOSTIC.exec(raw.trim());
    if (!match) continue;

    const [, file, line, column, severity, message] = match;
    if (!file || !line || !severity || message === undefined) continue;

    let normalized = file;
    if (stripPrefix && normalized.startsWith(stripPrefix)) {
      normalized = normalized.slice(stripPrefix.length).replace(/^\/+/, '');
    }

    out.push({
      file: normalized,
      line: Number.parseInt(line, 10),
      // "fatal error" is still an error as far as the editor is concerned.
      severity: severity === 'fatal error' ? 'error' : (severity as DiagnosticSeverity),
      message,
      ...(column ? { column: Number.parseInt(column, 10) } : {}),
    });
  }

  return out;
}

/** True if any diagnostic would stop the build. */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
