/**
 * The register file that sits behind most bus peripherals.
 *
 * Almost every sensor and display breakout, on I2C or SPI alike, is the same thing underneath: a
 * block of addressable bytes, some backed by a real measurement, that the host reads and writes
 * through whichever protocol the package happened to bring out. Only the framing differs -- I2C
 * sends a pointer byte then data, SPI sends a command byte carrying a read/write bit -- so the
 * storage, the scaling and the sign handling live here and each bus wraps them in its own framing.
 */

export interface RegisterSpec {
  readonly address: number;
  readonly name: string;
  readonly reset: number;
  readonly access: 'r' | 'w' | 'rw';
  /** Reads return this state variable, scaled. */
  readonly fromState?: string | undefined;
  readonly scale: number;
  readonly offset: number;
  /** Width in bytes, for values spanning several addresses. */
  readonly bytes: number;
}

export class RegisterFile {
  private readonly bytes = new Map<number, number>();
  private readonly specs = new Map<number, RegisterSpec>();

  constructor(
    specs: readonly RegisterSpec[],
    private readonly readState: (name: string) => number = () => 0,
  ) {
    for (const spec of specs) {
      this.specs.set(spec.address, spec);
      // Multi-byte registers occupy consecutive addresses, big-endian as most sensors use.
      for (let i = 0; i < spec.bytes; i++) {
        this.bytes.set(spec.address + i, (spec.reset >> (8 * (spec.bytes - 1 - i))) & 0xff);
      }
    }
  }

  /** Store a byte, honouring read-only registers the way hardware does: acknowledged, discarded. */
  write(address: number, byte: number): void {
    const spec = this.specs.get(address);
    if (!spec || spec.access !== 'r') this.bytes.set(address, byte & 0xff);
  }

  byteAt(address: number): number {
    // Find the register covering this address, so a multi-byte value backed by state renders
    // correctly across all of its bytes.
    for (const spec of this.specs.values()) {
      if (address < spec.address || address >= spec.address + spec.bytes) continue;
      if (spec.fromState === undefined) break;

      const raw = Math.round(this.readState(spec.fromState) * spec.scale + spec.offset);
      const width = spec.bytes * 8;
      // Two's complement in the register's own width, which is how signed sensor readings arrive.
      const masked = raw < 0 ? (raw + (1 << width)) & ((1 << width) - 1) : raw;
      const shift = 8 * (spec.bytes - 1 - (address - spec.address));
      return (masked >> shift) & 0xff;
    }
    return this.bytes.get(address) ?? 0;
  }

  /** Current value of a named register, for tests and the inspector. */
  read(name: string): number {
    for (const spec of this.specs.values()) {
      if (spec.name !== name) continue;
      let value = 0;
      for (let i = 0; i < spec.bytes; i++) value = (value << 8) | this.byteAt(spec.address + i);
      return value;
    }
    throw new Error(`No register named "${name}"`);
  }

  /** Every stored byte, for a display's framebuffer. */
  snapshot(): Map<number, number> {
    return new Map(this.bytes);
  }
}
