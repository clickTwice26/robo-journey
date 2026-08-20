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
  ManifestDevice,
  buildCircuit,
  fieldAt,
  installBuiltinManifests,
  isDriven,
  manifestToPartDefinition,
  parseProbeChannel,
  partDefinition,
  probeChannel,
  registerPart,
  splitTerminal,
  type BuiltCircuit,
  type ComponentManifest,
  type EnvironmentSource,
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
  type ScopeFrame,
  type ScopeTrace,
  type SoundingPart,
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
/**
 * Parts that make a noise when driven, and the terminals that decide whether they are.
 *
 * A short table rather than a manifest field, because emitting into the world is a property of a
 * handful of parts and inventing schema for it would be a lot of ceremony for two buzzers.
 */
const SOUND_EMITTERS: Record<
  string,
  { plus: string; minus: string; defaultDb: number; defaultHz: number }
> = {
  'buzzer-active': { plus: '+', minus: '-', defaultDb: 85, defaultHz: 2300 },
  // A passive buzzer has no pitch of its own. The figure here is only what to fall back on if it
  // is being held at a steady level, which is a passive buzzer being used wrongly.
  'buzzer-passive': { plus: '+', minus: '-', defaultDb: 75, defaultHz: 1000 },
};

/** Recorder channel holding a buzzer's drive waveform. */
const soundChannel = (partId: string): string => `sound:${partId}`;

/**
 * How much of the drive waveform to look at when measuring its pitch.
 *
 * Long enough to hold several cycles of the lowest note anyone plays on one of these, short enough
 * that a changing tone is heard as changing rather than smeared.
 */
const SOUND_WINDOW_SECONDS = 0.06;

/** Hold a value inside a state variable's declared range, as the real quantity would be. */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

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
    // Reset is the moment you get to replace the fuses, which is the only way to get a meter back
    // once its fuse has gone -- the same trip to the drawer it would be in real life.
    this.blownFuses.clear();
    this.rebuild();
  }

  setPartProp(partId: string, key: string, value: unknown): void {
    if (!this.project) return;
    const part = this.project.parts.find((p) => p.id === partId);

    this.project = {
      ...this.project,
      parts: this.project.parts.map((p) =>
        p.id === partId ? { ...p, props: { ...p.props, [key]: value } } : p,
      ),
    };

    // Some properties change only how a part is displayed. A scope's timebase is the case that
    // matters: rebuilding to apply it would clear the very capture you turned the knob to look at.
    if (part && this.isDisplayProp(part.type, key)) return;

    // Otherwise rebuilding is the honest way to apply the change: a resistance or a switch
    // position alters the circuit's stamps, and patching a live device would leave the netlist
    // stale. Preserve the MCU's progress so pressing a button does not restart the sketch.
    const cycles = this.built?.board.mcu.cycles ?? 0;
    this.rebuild();
    if (this.built && cycles > 0) this.built.board.runFor(0);
  }

  /**
   * Replace the stimuli on the workspace and push them straight into the sensors.
   *
   * Applied immediately rather than on the next tick so a paused simulation still responds while
   * someone drags a flame around -- watching a sensor react with the sketch stopped is a perfectly
   * reasonable way to check the wiring.
   */
  setEnvironment(sources: readonly EnvironmentSource[]): void {
    this.environment = [...sources];
    this.applyEnvironment();
  }

  /**
   * Work out what each sensor is exposed to and tell it.
   *
   * A part's state variable is only taken over when a source of that quantity is actually on the
   * workspace. With none placed, the part keeps whatever its own control says -- which is what
   * makes this additive rather than a replacement for the sliders.
   */
  private applyEnvironment(): void {
    this.driven = {};
    if (!this.built || !this.project) return;

    // Emitters in the circuit itself. A buzzer being driven is a sound source at its own position,
    // which is what lets a sound sensor across the bench hear it -- the loop from a pin, through
    // the buzzer, across the workspace and back in through another pin closes entirely inside the
    // simulation, and nothing about it is special-cased into either part.
    const sources = [...this.environment, ...this.circuitEmissions()];

    for (const part of this.project.parts) {
      const device = this.built.devices.get(part.id);
      if (!(device instanceof ManifestDevice)) continue;

      let definition;
      try {
        definition = partDefinition(part.type);
      } catch {
        continue;
      }

      for (const variable of definition.state ?? []) {
        if (!variable.quantity) continue;
        if (!isDriven(sources, variable.quantity)) continue;

        // The part's own control is the ambient level the sources add to, so a photoresistor in a
        // lit room still reads the room when a lamp is switched on nearby.
        const ambient =
          typeof part.props[variable.name] === 'number'
            ? (part.props[variable.name] as number)
            : variable.default;

        const value = clamp(
          fieldAt(sources, variable.quantity, part.x, part.y, ambient),
          variable.min,
          variable.max,
        );
        device.setState(variable.name, value);
        (this.driven[part.id] ??= {})[variable.name] = value;
      }
    }
  }

  /**
   * What each buzzer is doing, measured off its own drive waveform.
   *
   * Steady voltage means an active buzzer, which has a pitch of its own and sounds at it. A
   * waveform crossing back and forth means a passive one, whose pitch is whatever the sketch is
   * toggling the pin at -- so it is counted rather than assumed.
   */
  private soundingParts(): SoundingPart[] {
    if (!this.built || !this.project) return [];

    const board = this.built.board;
    const to = board.time;
    const from = Math.max(0, to - SOUND_WINDOW_SECONDS);
    const out: SoundingPart[] = [];

    for (const part of this.project.parts) {
      const emitter = SOUND_EMITTERS[part.type];
      if (!emitter) continue;

      const window = board.recorder.window(soundChannel(part.id), from, to, 4000);
      if (!window || window.values.length < 2) continue;

      let peak = 0;
      for (const value of window.values) peak = Math.max(peak, Math.abs(value));
      if (peak < 1) continue;

      // Crossings of half the peak, counted in one direction only -- a full cycle crosses twice.
      // Timed between the first and last crossing rather than across the whole window: the window
      // edges do not fall on cycle boundaries, and dividing by the window instead over-counts by
      // up to a cycle, which at low notes is most of the answer.
      const threshold = peak / 2;
      const crossings: number[] = [];
      for (let i = 1; i < window.values.length; i++) {
        const before = Math.abs(window.values[i - 1]!);
        const after = Math.abs(window.values[i]!);
        if (before < threshold && after >= threshold) crossings.push(window.times[i]!);
      }

      const elapsed = crossings.length >= 2 ? crossings[crossings.length - 1]! - crossings[0]! : 0;
      const declared = Number(part.props.frequencyHz ?? emitter.defaultHz);
      // Fewer than two crossings is a steady level, not a tone: that is an active buzzer being
      // switched on, and its pitch comes from the part rather than from the pin.
      const hz = elapsed > 0 ? (crossings.length - 1) / elapsed : declared;

      out.push({
        partId: part.id,
        hz: Math.min(12_000, Math.max(50, hz)),
        db: Number(part.props.volumeDb ?? emitter.defaultDb),
      });
    }

    return out;
  }

  /**
   * Sound coming out of the circuit rather than out of the toolkit.
   *
   * Only while the thing is actually being driven, read off the voltage across its own terminals
   * -- a buzzer wired up and never written to is silent, as it should be.
   */
  private circuitEmissions(): EnvironmentSource[] {
    if (!this.built || !this.project) return [];
    const out: EnvironmentSource[] = [];

    for (const part of this.project.parts) {
      const emitter = SOUND_EMITTERS[part.type];
      if (!emitter) continue;

      const plus = this.built.nodes.get(`${part.id}:${emitter.plus}`);
      const minus = this.built.nodes.get(`${part.id}:${emitter.minus}`);
      if (plus === undefined || minus === undefined) continue;

      const across = Math.abs(
        this.built.board.circuit.voltage(plus) - this.built.board.circuit.voltage(minus),
      );
      if (across < 1) continue;

      const volume = Number(part.props.volumeDb ?? emitter.defaultDb);
      out.push({
        id: `${part.id}:emitted-sound`,
        quantity: 'sound',
        x: part.x,
        y: part.y,
        // Under-driven is quieter, which is true and is why a buzzer on 3.3 V sounds feeble.
        intensity: volume - (1 - Math.min(1, across / 5)) * 12,
        reachMm: 60,
        active: true,
      });
    }

    return out;
  }

  private isDisplayProp(partType: string, key: string): boolean {
    try {
      return partDefinition(partType).displayProps?.includes(key) ?? false;
    } catch {
      return false;
    }
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
      if ((device as { blown?: boolean }).blown === true) this.blownFuses.add(partId);
    }

    const serial = this.serialBuffer;
    this.serialBuffer = '';

    return {
      scopes: this.scopeFrames(),
      sounds: this.soundingParts(),
      running: this.running,
      driven: this.driven,
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

  /**
   * Points per scope channel sent with every snapshot.
   *
   * Sized for the instrument's own screen, which is a few hundred pixels wide at most. The scope
   * *panel* asks for full resolution through `traces`; this is the face of the thing on the canvas
   * and it does not need more.
   */
  private static readonly SCREEN_POINTS = 160;

  /**
   * What each oscilloscope is showing right now.
   *
   * The recorder's own channel list is the source of truth for which scopes exist -- the id
   * carries the part it came from -- so nothing has to be kept in step with the project separately.
   */
  private scopeFrames(): Record<string, ScopeFrame> {
    const board = this.built?.board;
    if (!board) return {};

    const byPart = new Map<string, string[]>();
    for (const id of board.recorder.channelIds) {
      const probe = parseProbeChannel(id);
      if (!probe) continue;
      const pins = byPart.get(probe.partId) ?? [];
      pins.push(probe.pin);
      byPart.set(probe.partId, pins);
    }
    if (byPart.size === 0) return {};

    const now = board.time;
    const frames: Record<string, ScopeFrame> = {};

    for (const [partId, pins] of byPart) {
      const part = this.project?.parts.find((p) => p.id === partId);
      const span = Number(part?.props?.span ?? 0.05) || 0.05;
      const from = Math.max(0, now - span);
      const traces: ScopeTrace[] = [];

      for (const pin of pins.sort()) {
        // A probe clipped to nothing is not measuring zero volts, it is not measuring. The channel
        // still records -- its input sits at ground through its own megohm -- but drawing that as
        // a flat trace would put a line across the screen for every unused input, and those lines
        // sit exactly on top of the ones you are trying to look at.
        if (!this.isProbeConnected(partId, pin)) {
          traces.push({ pin, times: [], values: [], volts: 0 });
          continue;
        }

        const window = board.recorder.window(
          probeChannel(partId, pin),
          from,
          now,
          Simulation.SCREEN_POINTS,
        );
        traces.push({
          pin,
          times: window ? Array.from(window.times) : [],
          values: window ? Array.from(window.values) : [],
          volts: board.recorder.latest(probeChannel(partId, pin)),
        });
      }
      frames[partId] = { span, from, to: now, traces };
    }
    return frames;
  }

  /** Whether a wire runs to this probe at all. */
  private isProbeConnected(partId: string, pin: string): boolean {
    const terminal = `${partId}:${pin}`;
    return this.project?.wires.some((w) => w.from === terminal || w.to === terminal) ?? false;
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

  /**
   * Meters whose fuse has gone, so it stays gone.
   *
   * Every property change rebuilds the circuit, which builds fresh devices. Without this, blowing
   * a meter's fuse and then turning the dial would quietly repair it -- and blowing one is a
   * consequence worth keeping until someone resets.
   */
  private readonly blownFuses = new Set<string>();

  /** Stimuli currently on the workspace. Not part of the project the circuit is built from. */
  private environment: EnvironmentSource[] = [];
  /** Whether the circuit itself contains anything that radiates, so the tick can skip the check. */
  private hasCircuitEmitters = false;
  /** What the environment last supplied, for the snapshot. */
  private driven: Record<string, Record<string, number>> = {};

  private withBlownFuses(project: Project): Project {
    if (this.blownFuses.size === 0) return project;
    return {
      ...project,
      parts: project.parts.map((part) =>
        this.blownFuses.has(part.id)
          ? { ...part, props: { ...part.props, fuseBlown: true } }
          : part,
      ),
    };
  }

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
    this.built = buildCircuit(this.withBlownFuses(this.project), { progMem });

    // A circuit edit rebuilds the board, but breakpoints belong to the firmware and must persist
    // -- losing them every time a wire moves would make the debugger useless while wiring.
    for (const address of previousBreakpoints) this.built.board.setBreakpoint(address);

    this.hasCircuitEmitters = this.project.parts.some((p) => p.type in SOUND_EMITTERS);

    // Record what is across each buzzer. Sampled on every solve, which is the only way to see a
    // 2 kHz square wave -- reading the voltage once a frame would alias it into nonsense.
    for (const part of this.project.parts) {
      const emitter = SOUND_EMITTERS[part.type];
      if (!emitter) continue;
      const plus = this.built.nodes.get(`${part.id}:${emitter.plus}`);
      const minus = this.built.nodes.get(`${part.id}:${emitter.minus}`);
      if (plus === undefined || minus === undefined) continue;

      const circuit = this.built.board.circuit;
      this.built.board.watchProbe(
        { id: soundChannel(part.id), kind: 'analog', label: `${part.id} drive` },
        () => circuit.voltage(plus) - circuit.voltage(minus),
      );
    }

    // A rebuild makes fresh devices, which start at their defaults. Without this, moving a wire
    // would put every sensor back to its power-on state while the flame was still burning.
    this.applyEnvironment();

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
      // Refresh the world before advancing, because part of it comes from the circuit: a buzzer
      // that was silent last tick may be sounding now, and the sensor listening for it has to be
      // told before the sketch gets to read the pin. Skipped entirely when nothing is emitting,
      // so the ordinary circuit pays nothing for this.
      if (this.environment.length > 0 || this.hasCircuitEmitters) this.applyEnvironment();

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
