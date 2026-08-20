/**
 * The contract between the UI thread and the simulation worker.
 *
 * Everything crossing the boundary is a plain, structured-cloneable snapshot. No class instances,
 * no live references into the engine -- the UI reads a picture of the last frame and never touches
 * the solver, which is what lets the engine run flat out without the renderer stalling it.
 */
import type { ChannelSpec, DeviceReadout, DisasmLine, Fault } from '@robo-journey/sim-core';
import type { ComponentManifest, Project } from '@robo-journey/parts';

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
  /**
   * Live internals of parts that have any, by part id.
   *
   * What a probe cannot reach: a regulator's junction temperature, whether it is in dropout. Only
   * parts that report something appear here, so the usual circuit of resistors and LEDs adds
   * nothing to the frame.
   */
  readonly readouts: Record<string, readonly DeviceReadout[]>;
  /** Anything written to Serial since the last poll. Cleared on read. */
  readonly serial: string;
  /** Problems reported while building the circuit, e.g. an unknown part. */
  readonly problems: readonly string[];
  /** Byte address execution is stopped at, when a breakpoint stopped it. */
  readonly stoppedAt: number | null;
}

export const EMPTY_SNAPSHOT: SimSnapshot = {
  running: false,
  time: 0,
  cycles: 0,
  realtimeRatio: 0,
  pins: {},
  voltages: {},
  brightness: {},
  readouts: {},
  faults: [],
  serial: '',
  problems: [],
  stoppedAt: null,
};

/**
 * A trace, flattened for transfer.
 *
 * Plain arrays rather than typed arrays: comlink structured-clones these, and uPlot wants
 * `number[]` anyway, so converting once in the worker beats converting every frame in the UI.
 */
export interface TraceData {
  readonly id: string;
  readonly label: string;
  readonly kind: 'analog' | 'digital';
  readonly times: number[];
  readonly values: number[];
}

/** One decoded serial frame, for the analyser's annotation row. */
export interface DecodedFrame {
  readonly startTime: number;
  readonly endTime: number;
  readonly byte: number;
  readonly framingError: boolean;
}

/** A named I/O register and its current value. */
export interface RegisterValue {
  readonly name: string;
  readonly address: number;
  readonly value: number;
  /** Bit names, MSB first. Empty for registers whose bits have no individual meaning. */
  readonly bits: readonly string[];
}

export interface McuState {
  /** Program counter, as a byte address. */
  readonly pc: number;
  readonly stackPointer: number;
  readonly sreg: number;
  readonly cycles: number;
  readonly registers: readonly RegisterValue[];
  /** The 32 general-purpose registers r0-r31. */
  readonly gpr: number[];
}

export interface SimApi {
  /**
   * Teach the worker about a component that is not compiled in.
   *
   * The worker keeps its own part registry -- it is a separate module graph -- so a manifest
   * registered on the UI thread alone gives a part that draws and wires perfectly and then fails
   * to build with "unknown part type". Must arrive before any `load` that uses it, which call
   * order over the port guarantees.
   */
  registerManifest(manifest: ComponentManifest): void;
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

  /** Every channel available to plot. */
  channels(): ChannelSpec[];
  /** Begin recording a pin's voltage. Analog capture is opt-in because it is not cheap. */
  watchAnalog(label: string): void;
  /**
   * Samples for the given channels within a time window.
   *
   * `maxPoints` decimates: drawing 200k points into 800 pixels is 250 points per pixel of work
   * nobody can see.
   */
  traces(ids: string[], from: number, to: number, maxPoints?: number): TraceData[];
  /** Time span currently held in the capture buffer. */
  captureSpan(): { from: number; to: number };
  /** Decode a digital channel as asynchronous serial at the MCU's configured baud rate. */
  decodeSerial(id: string, from: number, to: number): DecodedFrame[];
  /** Current MCU registers and program counter. */
  mcuState(): McuState;

  /** Disassemble a span of flash. Byte addresses throughout, as avr-objdump uses. */
  disassembly(from: number, to: number): DisasmLine[];
  setBreakpoint(byteAddress: number): void;
  clearBreakpoint(byteAddress: number): void;
  clearBreakpoints(): void;
  breakpoints(): number[];
}
