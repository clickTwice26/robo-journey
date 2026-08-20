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
import {
  Led,
  decodeUart,
  disassemble,
  loadHex,
  type ChannelSpec,
  type DeviceReadout,
  type DisasmLine,
  type Fault,
} from '@robo-journey/sim-core';
import {
  buildCircuit,
  installBuiltinManifests,
  manifestToPartDefinition,
  registerPart,
  splitTerminal,
  type BuiltCircuit,
  type ComponentManifest,
  type Project,
} from '@robo-journey/parts';

// Built-in manifests, installed at module load. The worker has its own registry, and doing this
// here rather than waiting for a message means they cannot be missed by an ordering mistake.
installBuiltinManifests();
import {
  EMPTY_SNAPSHOT,
  type DecodedFrame,
  type McuState,
  type RegisterValue,
  type SimApi,
  type SimSnapshot,
  type TraceData,
} from './protocol.ts';

/**
 * I/O registers worth showing, with their bit names.
 *
 * Named rather than dumped as a hex range: `DDRB` with `DDB5` highlighted tells you the pin is an
 * output, whereas `0x24 = 0x20` makes you go and look it up. Addresses and bit names are from the
 * ATmega328P datasheet.
 */
const WATCHED_REGISTERS: { name: string; address: number; bits: string[] }[] = [
  { name: 'PINB', address: 0x23, bits: ['PINB7', 'PINB6', 'PINB5', 'PINB4', 'PINB3', 'PINB2', 'PINB1', 'PINB0'] },
  { name: 'DDRB', address: 0x24, bits: ['DDB7', 'DDB6', 'DDB5', 'DDB4', 'DDB3', 'DDB2', 'DDB1', 'DDB0'] },
  { name: 'PORTB', address: 0x25, bits: ['PORTB7', 'PORTB6', 'PORTB5', 'PORTB4', 'PORTB3', 'PORTB2', 'PORTB1', 'PORTB0'] },
  { name: 'PINC', address: 0x26, bits: [] },
  { name: 'DDRC', address: 0x27, bits: [] },
  { name: 'PORTC', address: 0x28, bits: [] },
  { name: 'PIND', address: 0x29, bits: [] },
  { name: 'DDRD', address: 0x2a, bits: [] },
  { name: 'PORTD', address: 0x2b, bits: [] },
  { name: 'TCCR0A', address: 0x44, bits: ['COM0A1', 'COM0A0', 'COM0B1', 'COM0B0', '-', '-', 'WGM01', 'WGM00'] },
  { name: 'TCCR0B', address: 0x45, bits: ['FOC0A', 'FOC0B', '-', '-', 'WGM02', 'CS02', 'CS01', 'CS00'] },
  { name: 'TCNT0', address: 0x46, bits: [] },
  { name: 'ADMUX', address: 0x7c, bits: ['REFS1', 'REFS0', 'ADLAR', '-', 'MUX3', 'MUX2', 'MUX1', 'MUX0'] },
  { name: 'ADCSRA', address: 0x7a, bits: ['ADEN', 'ADSC', 'ADATE', 'ADIF', 'ADIE', 'ADPS2', 'ADPS1', 'ADPS0'] },
  { name: 'UCSR0A', address: 0xc0, bits: ['RXC0', 'TXC0', 'UDRE0', 'FE0', 'DOR0', 'UPE0', 'U2X0', 'MPCM0'] },
  { name: 'UCSR0B', address: 0xc1, bits: ['RXCIE0', 'TXCIE0', 'UDRIE0', 'RXEN0', 'TXEN0', 'UCSZ02', 'RXB80', 'TXB80'] },
  { name: 'UBRR0L', address: 0xc4, bits: [] },
  { name: 'UBRR0H', address: 0xc5, bits: [] },
];

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
  /**
   * Flash image, kept alongside the board.
   *
   * Disassembly must survive a rebuild: editing the circuit re-creates the board, and the listing
   * belongs to the firmware rather than to the circuit around it.
   */
  private progMem: Uint16Array | null = null;

  /**
   * Register a manifest-described part.
   *
   * Failures are swallowed: registering the same part twice is normal when the stored library is
   * restored alongside a project that already contains it, and refusing the second one would take
   * out a working circuit for no reason.
   */
  registerManifest(manifest: ComponentManifest): void {
    try {
      registerPart(manifestToPartDefinition(manifest));
    } catch {
      // Already present, or shadowing a built-in.
    }
  }

  load(project: Project, hex: string): void {
    this.project = project;
    this.hex = hex;
    this.rebuild();
  }

  loadProject(project: Project): void {
    this.project = project;
    // Rebuild whenever firmware is already loaded, so an edit to the circuit takes effect
    // immediately rather than after the next compile. Restart from reset: the previous run's
    // state belongs to a circuit that no longer exists.
    if (this.hex) {
      const wasRunning = this.running;
      this.pause();
      this.rebuild();
      if (wasRunning) this.start();
    }
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
    // Board.stepInstruction settles the circuit afterwards and clears the stop, which is what lets
    // the debugger step off a breakpoint it is sitting on.
    this.built?.board.stepInstruction();
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
    const readouts: Record<string, readonly DeviceReadout[]> = {};
    for (const [partId, device] of devices) {
      // Before the `instanceof` below: narrowing leaves the value as `Device | Led`, and `Led` has
      // no `readout` of its own, so the optional call has to happen while it is still a `Device`.
      const values = device.readout?.();
      if (values && values.length > 0) readouts[partId] = values;
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
      readouts,
      faults: board.faults as Fault[],
      serial,
      problems: [...problems, ...this.runtimeProblems],
      stoppedAt: board.stoppedAtBreakpoint,
    };
  }

  channels(): ChannelSpec[] {
    return this.built?.board.recorder.specs() ?? [];
  }

  watchAnalog(label: string): void {
    this.built?.board.watchAnalog(label);
  }

  traces(ids: string[], from: number, to: number, maxPoints = 4000): TraceData[] {
    const recorder = this.built?.board.recorder;
    if (!recorder) return [];

    const out: TraceData[] = [];
    for (const id of ids) {
      const window = recorder.window(id, from, to, maxPoints);
      if (!window) continue;
      out.push({
        id: window.id,
        label: window.label,
        kind: window.kind,
        // Typed arrays would be cloned as objects across the worker boundary; uPlot wants plain
        // arrays anyway, so convert once here rather than every frame in the UI.
        times: Array.from(window.times),
        values: Array.from(window.values),
      });
    }
    return out;
  }

  captureSpan(): { from: number; to: number } {
    return this.built?.board.recorder.span() ?? { from: 0, to: 0 };
  }

  decodeSerial(id: string, from: number, to: number): DecodedFrame[] {
    const board = this.built?.board;
    if (!board) return [];

    // High point cap: decoding needs every recorded edge, and decimating would drop bits.
    const window = board.recorder.window(id, from, to, 1_000_000);
    if (!window) return [];

    const baud = Math.round(board.mcu.baudRate);
    if (!Number.isFinite(baud) || baud <= 0) return [];

    return decodeUart(window, { baud }).map((frame) => ({
      startTime: frame.startTime,
      endTime: frame.endTime,
      byte: frame.byte,
      framingError: frame.framingError,
    }));
  }

  mcuState(): McuState {
    const board = this.built?.board;
    if (!board) {
      return { pc: 0, stackPointer: 0, sreg: 0, cycles: 0, registers: [], gpr: [] };
    }

    const cpu = board.mcu.cpu;
    const registers: RegisterValue[] = WATCHED_REGISTERS.map((spec) => ({
      name: spec.name,
      address: spec.address,
      value: cpu.data[spec.address] ?? 0,
      bits: spec.bits,
    }));

    return {
      // avr8js counts the PC in words; a disassembly listing and avr-objdump both use bytes.
      pc: cpu.pc * 2,
      stackPointer: cpu.SP,
      sreg: cpu.SREG,
      cycles: cpu.cycles,
      registers,
      gpr: Array.from(cpu.data.subarray(0, 32)),
    };
  }

  disassembly(from: number, to: number): DisasmLine[] {
    if (!this.progMem) return [];
    return disassemble(this.progMem, { from, to });
  }

  setBreakpoint(byteAddress: number): void {
    this.built?.board.setBreakpoint(byteAddress);
  }

  clearBreakpoint(byteAddress: number): void {
    this.built?.board.clearBreakpoint(byteAddress);
  }

  clearBreakpoints(): void {
    this.built?.board.clearBreakpoints();
  }

  breakpoints(): number[] {
    return this.built?.board.breakpoints ?? [];
  }

  // -------------------------------------------------------------------------------------------

  private rebuild(): void {
    const previousBreakpoints = this.built?.board.breakpoints ?? [];
    this.detachSerial?.();
    this.detachSerial = null;
    this.serialBuffer = '';

    if (!this.project || !this.hex) {
      this.built = null;
      this.progMem = null;
      return;
    }

    this.runtimeProblems = [];
    const progMem = loadHex(this.hex);
    this.progMem = progMem;
    this.built = buildCircuit(this.project, { progMem });

    // A circuit edit rebuilds the board, but breakpoints belong to the firmware and must persist
    // -- losing them every time a wire moves would make the debugger useless while wiring.
    for (const address of previousBreakpoints) this.built.board.setBreakpoint(address);

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
