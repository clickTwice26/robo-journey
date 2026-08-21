/**
 * @robo-journey/compile-service
 *
 * Turns sketch sources into firmware. Used by the studio app over HTTP in development, and linked
 * directly by the Tauri desktop build.
 */
export {
  ArduinoCompiler,
  CompileError,
  ToolchainUnavailableError,
  toolchainProblem,
  DEFAULT_FQBN,
  DEFAULT_IMAGE,
  hashRequest,
} from './compiler.js';
export type {
  CompileRequest,
  CompileResult,
  CompilerOptions,
  SketchFile,
} from './compiler.js';

export { hasErrors, parseDiagnostics } from './diagnostics.js';
export type { Diagnostic, DiagnosticSeverity } from './diagnostics.js';
