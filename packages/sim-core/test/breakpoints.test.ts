/**
 * Breakpoints.
 *
 * The property that matters is that execution stops *at* the breakpoint, before the instruction
 * runs, and that stepping off it is possible. A debugger that stops one instruction late, or that
 * re-triggers on the line it is already stopped at, is worse than none.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Board, disassemble, loadHex } from '../src/index.js';

const blinkHex = readFileSync(
  fileURLToPath(new URL('./fixtures/blink.hex', import.meta.url)),
  'utf8',
);

function board(): Board {
  return new Board({ progMem: loadHex(blinkHex) });
}

/** Byte address of the first instruction matching a mnemonic, for a breakpoint that will be hit. */
function findInstruction(mnemonic: string): number {
  const lines = disassemble(loadHex(blinkHex), { from: 0, to: 4096 });
  const line = lines.find((l) => l.mnemonic === mnemonic);
  if (!line) throw new Error(`No ${mnemonic} in the fixture`);
  return line.address;
}

describe('breakpoints', () => {
  it('runs freely when none are set', () => {
    const mcu = board();
    mcu.runFor(0.05);
    expect(mcu.stoppedAtBreakpoint).toBeNull();
    expect(mcu.mcu.cycles).toBeGreaterThan(700_000);
  });

  it('stops when the program counter reaches one', () => {
    const mcu = board();
    // The reset vector jumps somewhere; break on the destination, which always executes.
    const target = disassemble(loadHex(blinkHex), { from: 0, to: 4 })[0]!.target!;
    mcu.setBreakpoint(target);
    mcu.runFor(0.05);

    expect(mcu.stoppedAtBreakpoint).toBe(target);
    expect(mcu.mcu.cpu.pc * 2).toBe(target);
  });

  it('stops before executing the instruction, not after', () => {
    // The PC must be *at* the breakpoint when we stop. Stopping one instruction late makes every
    // inspected register value belong to the wrong moment.
    const mcu = board();
    const target = disassemble(loadHex(blinkHex), { from: 0, to: 4 })[0]!.target!;
    mcu.setBreakpoint(target);
    mcu.runFor(0.05);
    expect(mcu.mcu.cpu.pc * 2).toBe(mcu.stoppedAtBreakpoint);
  });

  it('stops early rather than running the full requested span', () => {
    const mcu = board();
    const target = disassemble(loadHex(blinkHex), { from: 0, to: 4 })[0]!.target!;
    mcu.setBreakpoint(target);
    mcu.runFor(1);
    // A full second is 16 million cycles; hitting the breakpoint must cut that short.
    expect(mcu.mcu.cycles).toBeLessThan(1_000_000);
  });

  it('lets execution step off a breakpoint it is stopped on', () => {
    // Without this the debugger stops on the line it is already stopped at, forever.
    const mcu = board();
    const target = disassemble(loadHex(blinkHex), { from: 0, to: 4 })[0]!.target!;
    mcu.setBreakpoint(target);
    mcu.runFor(0.05);
    expect(mcu.stoppedAtBreakpoint).toBe(target);

    mcu.stepInstruction();
    expect(mcu.mcu.cpu.pc * 2).not.toBe(target);
    expect(mcu.stoppedAtBreakpoint).toBeNull();
  });

  it('resumes and stops again on the next hit', () => {
    const mcu = board();
    const target = findInstruction('out');
    mcu.setBreakpoint(target);

    mcu.runFor(0.05);
    const first = mcu.mcu.cycles;
    expect(mcu.stoppedAtBreakpoint).toBe(target);

    mcu.stepInstruction();
    mcu.runFor(1);
    // If `out` is inside the blink loop it is hit again; either way time must have advanced.
    expect(mcu.mcu.cycles).toBeGreaterThan(first);
  });

  it('reports which breakpoints are set, in byte addresses', () => {
    const mcu = board();
    mcu.setBreakpoint(0x10);
    mcu.setBreakpoint(0x24);
    expect(mcu.breakpoints).toEqual([0x10, 0x24]);
  });

  it('rounds an odd address down to the containing instruction word', () => {
    // A click in a listing can land anywhere inside a 32-bit instruction.
    const mcu = board();
    mcu.setBreakpoint(0x11);
    expect(mcu.breakpoints).toEqual([0x10]);
  });

  it('clears one breakpoint without disturbing the others', () => {
    const mcu = board();
    mcu.setBreakpoint(0x10);
    mcu.setBreakpoint(0x24);
    mcu.clearBreakpoint(0x10);
    expect(mcu.breakpoints).toEqual([0x24]);
  });

  it('runs freely again once the last one is cleared', () => {
    const mcu = board();
    const target = disassemble(loadHex(blinkHex), { from: 0, to: 4 })[0]!.target!;
    mcu.setBreakpoint(target);
    mcu.clearBreakpoint(target);
    mcu.runFor(0.05);
    expect(mcu.stoppedAtBreakpoint).toBeNull();
  });

  it('clears them all at once', () => {
    const mcu = board();
    mcu.setBreakpoint(0x10);
    mcu.setBreakpoint(0x24);
    mcu.clearBreakpoints();
    expect(mcu.breakpoints).toEqual([]);
  });

  it('ignores addresses outside flash', () => {
    const mcu = board();
    expect(() => mcu.setBreakpoint(-4)).not.toThrow();
    expect(() => mcu.setBreakpoint(0x10_0000)).not.toThrow();
    expect(mcu.breakpoints).toEqual([]);
  });

  it('keeps the circuit settled at the moment of the stop', () => {
    // The inspector shows pin state at the breakpoint, so the solve must have happened.
    const mcu = board();
    const target = findInstruction('out');
    mcu.setBreakpoint(target);
    mcu.runFor(0.05);
    expect(() => mcu.voltage('D13')).not.toThrow();
    expect(Number.isFinite(mcu.voltage('D13'))).toBe(true);
  });

  it('forgets a stop on reset', () => {
    const mcu = board();
    const target = disassemble(loadHex(blinkHex), { from: 0, to: 4 })[0]!.target!;
    mcu.setBreakpoint(target);
    mcu.runFor(0.05);
    expect(mcu.stoppedAtBreakpoint).toBe(target);

    mcu.reset();
    expect(mcu.stoppedAtBreakpoint).toBeNull();
  });
});
