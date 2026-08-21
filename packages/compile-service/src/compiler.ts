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

/**
 * The three ways the toolchain can be missing, which need three different things done about them.
 *
 * Lumping them together is how somebody ends up reading "start Docker Desktop" while Docker is
 * running perfectly well and the real answer is that an image has never been built here.
 */
export type ToolchainProblem = 'daemon' | 'image' | 'binary';

const REMEDIES: Record<ToolchainProblem, string> = {
  daemon: 'Docker does not appear to be running -- start Docker Desktop and try again.',
  // The image is built locally and never pulled: it is not on any registry, so a fresh checkout
  // has no way to obtain it and `docker run` reports it as an access-denied pull.
  image:
    'The arduino-cli image has not been built on this machine yet. It is built locally rather ' +
    'than pulled, so a fresh checkout does not have one:\n\n    npm run image:build\n\n' +
    'That takes a few minutes the first time. Afterwards compiling is offline and repeatable.',
  binary: 'Docker is not installed, or not on this process\'s PATH. See https://docs.docker.com/engine/install/',
};

/**
 * The toolchain itself is unavailable, as distinct from the sketch failing to compile.
 *
 * Worth its own type because the remedy is completely different: a compile error means fix your
 * code, this means fix your machine. Reporting the raw daemon error as a sketch diagnostic --
 * which is what happened the first time this occurred -- puts an unactionable message on line 1 of
 * a file that is perfectly fine.
 */
export class ToolchainUnavailableError extends CompileError {
  readonly problem: ToolchainProblem;

  constructor(problem: ToolchainProblem, detail: string) {
    super(`The compile toolchain is unavailable. ${REMEDIES[problem]}\n\nDetail: ${detail}`);
    this.name = 'ToolchainUnavailableError';
    this.problem = problem;
  }
}

/**
 * Which toolchain problem this stderr describes, or null if it is a real build failure.
 *
 * The image case is checked on its own signatures rather than on the exit code, because docker
 * exits 125 for everything it decides before the container starts.
 */
export function toolchainProblem(stderr: string): ToolchainProblem | null {
  if (
    /cannot connect to the docker daemon/i.test(stderr) ||
    /failed to connect to the docker API/i.test(stderr) ||
    /is the docker daemon running/i.test(stderr)
  ) {
    return 'daemon';
  }
  if (/docker: command not found/i.test(stderr) || /executable file not found/i.test(stderr)) {
    return 'binary';
  }
  if (
    /unable to find image/i.test(stderr) ||
    /pull access denied/i.test(stderr) ||
    /repository does not exist/i.test(stderr) ||
    /manifest .* not found/i.test(stderr)
  ) {
    return 'image';
  }
  return null;
}

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
    // ENOENT here means the binary itself is missing (no docker, no arduino-cli), which is a
    // toolchain problem rather than a build failure.
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new ToolchainUnavailableError('binary', `\`${command}\` is not installed or not on PATH`));
        return;
      }
      reject(error);
    });
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
  /**
   * Where the toolchain lives.
   *
   * `docker` runs the pinned image, which is right on a developer machine with Docker but no
   * arduino-cli installed. `local` runs the binary on PATH, which is what the service container
   * provides -- running the service in a container and still choosing `docker` would mean mounting
   * the host's Docker socket, and that hands the container root on the host.
   */
  readonly mode?: 'local' | 'docker';
  /** @deprecated Use `mode`. Kept so existing callers keep working. */
  readonly local?: boolean;
}

export class ArduinoCompiler {
  private readonly image: string;
  private readonly local: boolean;

  constructor(options: CompilerOptions = {}) {
    this.image = options.image ?? DEFAULT_IMAGE;
    this.local = options.mode !== undefined ? options.mode === 'local' : (options.local ?? false);
  }

  /** The cache key for a request, without compiling it. */
  hashRequest(request: CompileRequest): string {
    return hashRequest(request);
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
          // No parseable diagnostics and a non-zero exit means the tool itself failed, not the
          // sketch. Separate out the toolchain cases so the user is told what to actually do.
          const problem = toolchainProblem(result.stderr);
          if (problem) {
            throw new ToolchainUnavailableError(problem, result.stderr.trim().split('\n')[0] ?? '');
          }
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
