/**
 * Diagnostic parsing runs against captured avr-gcc stderr, so it needs neither Docker nor a
 * toolchain. These are the strings Monaco will draw squiggles from.
 */
import { describe, expect, it } from 'vitest';
import {
  ToolchainUnavailableError,
  hasErrors,
  parseDiagnostics,
  toolchainProblem,
} from '../src/index.js';

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

/**
 * Telling apart "your code is wrong" from "your machine is not set up".
 *
 * Reported from the app, on a fresh checkout with Docker running perfectly well:
 *
 *   arduino-cli exited 125 without diagnostics:
 *   Unable to find image 'robo-journey/arduino-cli:latest' locally
 *   docker: Error response from daemon: pull access denied for robo-journey/arduino-cli
 *
 * Nothing in that says what to do, and the thing to do -- `npm run image:build` -- is not
 * guessable: the image is built locally and never pulled, so it exists on no registry.
 */
describe('toolchainProblem', () => {
  it('recognises an image that was never built here', () => {
    const stderr = [
      "Unable to find image 'robo-journey/arduino-cli:latest' locally",
      "docker: Error response from daemon: pull access denied for robo-journey/arduino-cli," +
        " repository does not exist or may require 'docker login'",
    ].join('\n');
    expect(toolchainProblem(stderr)).toBe('image');
    expect(new ToolchainUnavailableError('image', stderr).message).toContain('npm run image:build');
  });

  it('recognises a daemon that is not running', () => {
    expect(
      toolchainProblem('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.'),
    ).toBe('daemon');
    expect(
      toolchainProblem('failed to connect to the docker API at unix:///Users/x/.docker/run/docker.sock'),
    ).toBe('daemon');
  });

  it('recognises docker not being installed', () => {
    expect(toolchainProblem('sh: docker: command not found')).toBe('binary');
  });

  // The distinction is the whole point: a sketch that does not compile must reach the editor as a
  // diagnostic on the offending line, not as a message about somebody's Docker installation.
  it('leaves a real build failure alone', () => {
    expect(
      toolchainProblem("/sketch/sketch.ino:4:3: error: 'digitalWrit' was not declared in this scope"),
    ).toBeNull();
    expect(toolchainProblem('')).toBeNull();
  });

  it('gives each cause its own remedy', () => {
    const messages = (['daemon', 'image', 'binary'] as const).map(
      (p) => new ToolchainUnavailableError(p, 'detail').message,
    );
    expect(new Set(messages).size).toBe(3);
    expect(messages[0]).toContain('Docker Desktop');
    expect(messages[2]).toContain('docs.docker.com');
  });
});
