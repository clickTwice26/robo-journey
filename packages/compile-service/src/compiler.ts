/**
 * Arduino sketch -> firmware.
 *
 * Runs `arduino-cli` in the pinned Docker image so a given sketch always yields the same bytes.
 * The desktop build will run the same binary natively; only `runArduinoCli` changes, which is why
 * the process invocation is isolated behind it.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { type Diagnostic, hasErrors, parseDiagnostics } from './diagnostics.js';

export const DEFAULT_IMAGE = 'robo-journey/arduino-cli:latest';
export const DEFAULT_FQBN = 'arduino:avr:uno';

/** Where the sketch is mounted inside the container. Diagnostics are stripped back to this root. */
const CONTAINER_SKETCH_ROOT = '/sketch';

export interface SketchFile {
  /** Path relative to the sketch root, e.g. "sketch.ino" or "lib/helper.h". */
  readonly name: string;
  readonly contents: string;
}

export interface CompileRequest {
  readonly files: readonly SketchFile[];
  readonly fqbn?: string;
}

export interface CompileResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  /** Intel HEX text, present only on success. */
  readonly hex?: string;
  /** ELF, for the symbol map that feeds disassembly and the variable inspector. */
  readonly elf?: Uint8Array;
  /** Content hash of the request, usable as a cache key. */
  readonly hash: string;
  readonly stderr: string;
}

export class CompileError extends Error {}

/** Stable hash over the sketch sources plus the target board. */
export function hashRequest(request: CompileRequest): string {
  const hash = createHash('sha256');
  hash.update(request.fqbn ?? DEFAULT_FQBN);
  // Sort so that map iteration order can never change the key.
  for (const file of [...request.files].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update('\0');
    hash.update(file.name);
    hash.update('\0');
    hash.update(file.contents);
  }
  return hash.digest('hex');
}

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Reject path traversal in sketch filenames.
 *
 * Sketch sources arrive from the browser; without this a crafted name could write outside the
 * temporary sketch directory when the service is hosted.
 */
function assertSafeName(name: string): void {
  if (name.length === 0 || name.startsWith('/') || name.split(/[\\/]/).includes('..')) {
    throw new CompileError(`Unsafe sketch file name: ${JSON.stringify(name)}`);
  }
}

export interface CompilerOptions {
  readonly image?: string;
  /** Use a locally installed arduino-cli instead of Docker. */
  readonly local?: boolean;
}

export class ArduinoCompiler {
  private readonly image: string;
  private readonly local: boolean;

  constructor(options: CompilerOptions = {}) {
    this.image = options.image ?? DEFAULT_IMAGE;
    this.local = options.local ?? false;
  }

  /**
   * Compile a sketch.
   *
   * A failed build is a normal outcome, not an exception: the caller wants the diagnostics so the
   * editor can mark them. Only infrastructure failures (Docker missing, image absent) throw.
   */
  async compile(request: CompileRequest): Promise<CompileResult> {
    if (request.files.length === 0) throw new CompileError('No sketch files supplied');
    for (const file of request.files) assertSafeName(file.name);

    const fqbn = request.fqbn ?? DEFAULT_FQBN;
    const hash = hashRequest(request);
    const workDir = await mkdtemp(join(tmpdir(), 'robo-journey-'));

    // arduino-cli requires the sketch directory name to match the main .ino file name.
    const sketchDir = join(workDir, 'sketch');
    const outDir = join(workDir, 'out');

    try {
      await mkdir(sketchDir, { recursive: true });
      for (const file of request.files) {
        const target = join(sketchDir, file.name);
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, file.contents, 'utf8');
      }

      const result = await this.runArduinoCli(workDir, fqbn);
      const diagnostics = parseDiagnostics(result.stderr, `${CONTAINER_SKETCH_ROOT}/sketch`);

      if (result.code !== 0 || hasErrors(diagnostics)) {
        if (result.code !== 0 && diagnostics.length === 0) {
          // No parseable diagnostics and a non-zero exit means the tool itself failed.
          throw new CompileError(
            `arduino-cli exited ${result.code} without diagnostics:\n${result.stderr.trim()}`,
          );
        }
        return { ok: false, diagnostics, hash, stderr: result.stderr };
      }

      const hex = await readFile(join(outDir, 'sketch.ino.hex'), 'utf8');
      const elf = await readFile(join(outDir, 'sketch.ino.elf'));

      return {
        ok: true,
        diagnostics,
        hex,
        elf: new Uint8Array(elf),
        hash,
        stderr: result.stderr,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** The one method the Tauri desktop build swaps out for a native arduino-cli invocation. */
  private async runArduinoCli(workDir: string, fqbn: string): Promise<ProcessResult> {
    const cliArgs = [
      'compile',
      '--fqbn',
      fqbn,
      '--output-dir',
      `${CONTAINER_SKETCH_ROOT}/out`,
      `${CONTAINER_SKETCH_ROOT}/sketch`,
    ];

    if (this.local) {
      return run('arduino-cli', [
        'compile',
        '--fqbn',
        fqbn,
        '--output-dir',
        join(workDir, 'out'),
        join(workDir, 'sketch'),
      ]);
    }

    return run('docker', [
      'run',
      '--rm',
      // No network: compilation must be hermetic. A sketch that tries to pull a library at build
      // time should fail loudly rather than produce a binary we cannot reproduce.
      '--network',
      'none',
      '-v',
      `${workDir}:${CONTAINER_SKETCH_ROOT}`,
      this.image,
      ...cliArgs,
    ]);
  }
}
