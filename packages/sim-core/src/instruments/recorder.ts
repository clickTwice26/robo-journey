/**
 * Signal capture.
 *
 * Records what every channel did, so a scope and a logic analyser have something to draw. The
 * design point that matters: samples are taken on every analog solve, and the solver already
 * re-solves the instant a pin changes drive state. That means an edge is recorded at its exact
 * time rather than at the next tick of a fixed sample clock -- which is the difference between a
 * logic analyser that can decode a 115200-baud UART frame and one that cannot.
 *
 * Storage is a fixed-capacity ring per channel over flat `Float64Array`s. Bounded memory matters:
 * a sketch left running overnight must not grow the heap, and an unbounded array would.
 */

export type ChannelKind = 'analog' | 'digital';

export interface ChannelSpec {
  readonly id: string;
  readonly kind: ChannelKind;
  /** Shown on the scope legend. */
  readonly label: string;
}

/** A window of samples for one channel, oldest first. */
export interface ChannelWindow {
  readonly id: string;
  readonly label: string;
  readonly kind: ChannelKind;
  readonly times: Float64Array;
  readonly values: Float64Array;
}

/** One recorded edge, for protocol decoding. */
export interface Edge {
  readonly time: number;
  /** Level after the transition. */
  readonly level: boolean;
}

class Channel {
  readonly times: Float64Array;
  readonly values: Float64Array;
  /** Index the next sample goes to. */
  private head = 0;
  /** Number of valid samples, up to capacity. */
  private count = 0;

  constructor(
    readonly spec: ChannelSpec,
    readonly capacity: number,
  ) {
    this.times = new Float64Array(capacity);
    this.values = new Float64Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  /** Most recent value, or 0 before anything is recorded. */
  get last(): number {
    if (this.count === 0) return 0;
    return this.values[(this.head - 1 + this.capacity) % this.capacity]!;
  }

  get lastTime(): number {
    if (this.count === 0) return 0;
    return this.times[(this.head - 1 + this.capacity) % this.capacity]!;
  }

  push(time: number, value: number): void {
    this.times[this.head] = time;
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Sample at ring position `i`, where 0 is the oldest retained sample. */
  at(i: number): { time: number; value: number } {
    const index = (this.head - this.count + i + this.capacity * 2) % this.capacity;
    return { time: this.times[index]!, value: this.values[index]! };
  }
}

export interface RecorderOptions {
  /**
   * Samples retained per channel.
   *
   * Sized for the mix rather than for one channel: twenty pins recorded digitally at 32 k samples
   * each is 10 MB, and digital channels only store transitions, so that is hours of a blinking
   * pin. Analog channels store every solve and fill far faster, which is why they are opt-in.
   */
  readonly capacity?: number;
}

const DEFAULT_CAPACITY = 32_768;

export class SignalRecorder {
  private readonly channels = new Map<string, Channel>();
  private readonly capacity: number;

  constructor(options: RecorderOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
  }

  addChannel(spec: ChannelSpec): void {
    if (this.channels.has(spec.id)) return;
    this.channels.set(spec.id, new Channel(spec, this.capacity));
  }

  get channelIds(): string[] {
    return [...this.channels.keys()];
  }

  specs(): ChannelSpec[] {
    return [...this.channels.values()].map((c) => c.spec);
  }

  /**
   * Record a sample.
   *
   * Consecutive identical values on a *digital* channel are dropped: a pin sitting high for half a
   * second would otherwise fill the ring with thousands of identical samples and push the edge
   * that matters out the back. Analog channels keep every sample, because their value is the
   * waveform.
   */
  sample(id: string, time: number, value: number): void {
    const channel = this.channels.get(id);
    if (!channel) return;

    if (channel.spec.kind === 'digital' && channel.length > 0 && channel.last === value) {
      return;
    }
    channel.push(time, value);
  }

  /** Latest recorded value for a channel. */
  latest(id: string): number {
    return this.channels.get(id)?.last ?? 0;
  }

  /** Time span currently held, seconds. */
  span(): { from: number; to: number } {
    let from = Infinity;
    let to = -Infinity;
    for (const channel of this.channels.values()) {
      if (channel.length === 0) continue;
      from = Math.min(from, channel.at(0).time);
      to = Math.max(to, channel.lastTime);
    }
    return Number.isFinite(from) ? { from, to } : { from: 0, to: 0 };
  }

  /**
   * Samples for a channel within a time window.
   *
   * `maxPoints` decimates evenly when the window holds more samples than the display can use.
   * uPlot is fast but it is not free, and drawing 200k points into 800 pixels is 250 points per
   * pixel of wasted work.
   */
  window(id: string, from: number, to: number, maxPoints = 4000): ChannelWindow | null {
    const channel = this.channels.get(id);
    if (!channel) return null;

    // Binary search would help on a full ring, but a linear scan over 200k Float64 entries is
    // well under a millisecond and this runs once per frame at most.
    const indices: number[] = [];
    for (let i = 0; i < channel.length; i++) {
      const time = channel.at(i).time;
      if (time < from) continue;
      if (time > to) break;
      indices.push(i);
    }

    const step = Math.max(1, Math.ceil(indices.length / maxPoints));
    const kept: number[] = [];
    for (let i = 0; i < indices.length; i += step) kept.push(indices[i]!);
    // Always keep the final sample so the trace reaches the right-hand edge.
    const lastIndex = indices[indices.length - 1];
    if (lastIndex !== undefined && kept[kept.length - 1] !== lastIndex) kept.push(lastIndex);

    const times = new Float64Array(kept.length);
    const values = new Float64Array(kept.length);
    kept.forEach((index, slot) => {
      const sample = channel.at(index);
      times[slot] = sample.time;
      values[slot] = sample.value;
    });

    return {
      id,
      label: channel.spec.label,
      kind: channel.spec.kind,
      times,
      values,
    };
  }

  /**
   * Transitions on a digital channel within a window.
   *
   * Protocol decoders work on edges, not samples: what matters for a UART frame is when the line
   * fell, not what it was doing in between.
   */
  edges(id: string, from = -Infinity, to = Infinity): Edge[] {
    const channel = this.channels.get(id);
    if (!channel || channel.spec.kind !== 'digital') return [];

    const edges: Edge[] = [];
    let previous: number | null = null;
    for (let i = 0; i < channel.length; i++) {
      const { time, value } = channel.at(i);
      if (previous !== null && value !== previous && time >= from && time <= to) {
        edges.push({ time, level: value > 0.5 });
      }
      previous = value;
    }
    return edges;
  }

  clear(): void {
    for (const channel of this.channels.values()) channel.clear();
  }
}
