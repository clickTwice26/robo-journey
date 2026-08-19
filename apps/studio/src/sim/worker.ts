/**
 * The simulation worker.
 *
 * The engine runs here, off the UI thread, so a Newton iteration never delays a repaint and a
 * repaint never delays the engine. The main thread only ever asks for a snapshot.
 *
 * Pacing matters as much as speed. The loop advances simulated time to match wall-clock time,
 * capped per tick: without the cap, a backgrounded tab returning after ten seconds would try to
 * simulate ten seconds in one blocking call and freeze the worker.
 */
import * as Comlink from 'comlink';
import { Led, loadHex, type Fault } from '@robo-journey/sim-core';
import { buildCircuit, splitTerminal, type BuiltCircuit, type Project } from '@robo-journey/parts';
import { EMPTY_SNAPSHOT, type SimApi, type SimSnapshot } from './protocol.ts';

/** Target frame interval, milliseconds. */
const TICK_MS = 16;
/**
 * Most simulated time to advance in a single tick, seconds.
 *
 * Two jobs: it stops a stalled tab from trying to catch up all at once, and it bounds how long the
 * worker is unresponsive to a pause request.
 */
const MAX_CHUNK_SECONDS = 0.05;

class Simulation implements SimApi {
  private built: BuiltCircuit | null = null;
  private project: Project | null = null;
  private hex: string | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private lastTickMs = 0;
  private realtimeRatio = 0;
  private serialBuffer = '';
  private detachSerial: (() => void) | null = null;
  /** Errors thrown by the engine, surfaced through the snapshot rather than killing the worker. */
  private runtimeProblems: string[] = [];

  load(project: Project, hex: string): void {
    this.project = project;
    this.hex = hex;
    this.rebuild();
  }

  loadProject(project: Project): void {
    this.project = project;
    if (this.hex) this.rebuild();
  }

  start(): void {
    if (!this.built || this.running) return;
    this.running = true;
    this.lastTickMs = performance.now();
    this.schedule();
  }

  pause(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  stepInstruction(): void {
    this.pause();
    this.built?.board.mcu.step();
  }

  stepTime(seconds: number): void {
    this.pause();
    this.built?.board.runFor(seconds);
  }

  reset(): void {
    this.pause();
    this.rebuild();
  }

  setPartProp(partId: string, key: string, value: unknown): void {
    if (!this.project) return;
    this.project = {
      ...this.project,
      parts: this.project.parts.map((p) =>
        p.id === partId ? { ...p, props: { ...p.props, [key]: value } } : p,
      ),
    };
    // Rebuilding is the honest way to apply a property change: a resistance or a switch position
    // alters the circuit's stamps, and patching a live device would leave the netlist stale.
    // Preserve the MCU's progress so pressing a button does not restart the sketch.
    const cycles = this.built?.board.mcu.cycles ?? 0;
    this.rebuild();
    if (this.built && cycles > 0) this.built.board.runFor(0);
  }

  snapshot(): SimSnapshot {
    if (!this.built) return EMPTY_SNAPSHOT;

    const { board, devices, nodes, problems } = this.built;

    const pins: Record<string, string> = {};
    for (const label of PIN_LABELS) pins[label] = board.mcu.pinState(label);

    // Only terminals that resolved to a node have a voltage; unused breadboard strips have none.
    const voltages: Record<string, number> = {};
    for (const [terminal, node] of nodes) {
      voltages[terminal] = board.circuit.voltage(node);
    }

    const brightness: Record<string, number> = {};
    for (const [partId, device] of devices) {
      if (device instanceof Led) brightness[partId] = device.brightness;
    }

    const serial = this.serialBuffer;
    this.serialBuffer = '';

    return {
      running: this.running,
      time: board.time,
      cycles: board.mcu.cycles,
      realtimeRatio: this.realtimeRatio,
      pins,
      voltages,
      brightness,
      faults: board.faults as Fault[],
      serial,
      problems: [...problems, ...this.runtimeProblems],
    };
  }

  // -------------------------------------------------------------------------------------------

  private rebuild(): void {
    this.detachSerial?.();
    this.detachSerial = null;
    this.serialBuffer = '';

    if (!this.project || !this.hex) {
      this.built = null;
      return;
    }

    this.runtimeProblems = [];
    const progMem = loadHex(this.hex);
    this.built = buildCircuit(this.project, { progMem });

    this.detachSerial = this.built.board.mcu.onSerialByte((byte) => {
      // Cap the buffer: a sketch printing in a tight loop must not grow this without bound
      // between polls.
      if (this.serialBuffer.length < 64_000) {
        this.serialBuffer += String.fromCharCode(byte);
      }
    });
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    if (!this.running || !this.built) return;

    const now = performance.now();
    const elapsed = (now - this.lastTickMs) / 1000;
    this.lastTickMs = now;

    const requested = Math.min(elapsed, MAX_CHUNK_SECONDS);
    const started = performance.now();
    try {
      this.built.board.runFor(requested);
    } catch (error) {
      // A circuit that cannot be solved must not take the worker down: stop, and let the snapshot
      // carry the problem up to the Problems panel.
      this.running = false;
      this.runtimeProblems.push((error as Error).message);
      return;
    }
    const spent = (performance.now() - started) / 1000;
    this.realtimeRatio = spent > 0 ? requested / spent : 0;

    this.schedule();
  }
}

/** Header pins the UI cares about. Mirrors the Uno's silkscreen. */
const PIN_LABELS = [
  'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7',
  'D8', 'D9', 'D10', 'D11', 'D12', 'D13',
  'A0', 'A1', 'A2', 'A3', 'A4', 'A5',
];

Comlink.expose(new Simulation());
