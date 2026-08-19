/**
 * The contract between the UI thread and the simulation worker.
 *
 * Everything crossing the boundary is a plain, structured-cloneable snapshot. No class instances,
 * no live references into the engine -- the UI reads a picture of the last frame and never touches
 * the solver, which is what lets the engine run flat out without the renderer stalling it.
 */
import type { Fault } from '@robo-journey/sim-core';
import type { Project } from '@robo-journey/parts';

export interface SimSnapshot {
  readonly running: boolean;
  /** Simulated seconds since reset. */
  readonly time: number;
  readonly cycles: number;
  /** How fast simulated time is advancing against wall clock, for the status bar. */
  readonly realtimeRatio: number;
  /** Drive state per header pin label. */
  readonly pins: Record<string, string>;
  /** Voltage per terminal id, for probes and for colouring wires. */
  readonly voltages: Record<string, number>;
  /** Perceived brightness 0-1 per LED part id. */
  readonly brightness: Record<string, number>;
  readonly faults: readonly Fault[];
  /** Anything written to Serial since the last poll. Cleared on read. */
  readonly serial: string;
  /** Problems reported while building the circuit, e.g. an unknown part. */
  readonly problems: readonly string[];
}

export const EMPTY_SNAPSHOT: SimSnapshot = {
  running: false,
  time: 0,
  cycles: 0,
  realtimeRatio: 0,
  pins: {},
  voltages: {},
  brightness: {},
  faults: [],
  serial: '',
  problems: [],
};

export interface SimApi {
  /** Load a project and its compiled firmware. Resets the simulation. */
  load(project: Project, hex: string): void;
  /** Load a project without firmware, so the canvas can still show a static circuit. */
  loadProject(project: Project): void;
  start(): void;
  pause(): void;
  /** Advance one instruction, for stepping through code. */
  stepInstruction(): void;
  /** Advance a fixed slice of simulated time. */
  stepTime(seconds: number): void;
  reset(): void;
  /** Set a part property live, e.g. pressing a button. */
  setPartProp(partId: string, key: string, value: unknown): void;
  /** Read the latest snapshot. Consumes buffered serial output. */
  snapshot(): SimSnapshot;
}
