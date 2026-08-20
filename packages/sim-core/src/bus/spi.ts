/**
 * SPI bus.
 *
 * SPI differs from I2C in the way that matters most here: there is no address on the wire. The
 * master selects a device by pulling its chip-select pin low with an ordinary GPIO write, and the
 * bus itself carries no indication of who is being talked to. avr8js hands us the MOSI byte and
 * waits for the MISO byte; deciding whose byte it is means looking at the actual voltage on each
 * device's CS pin, which is why this bus reads the circuit rather than keeping a routing table.
 *
 * That detail is also where most SPI bugs live. Forgetting to drive CS low, driving the wrong pin,
 * or leaving two devices selected at once all produce a transaction that looks perfectly healthy
 * at the protocol level and returns 0xFF or garbage forever. A bus that routed by registration
 * order would simulate all three as working.
 */

import { RegisterFile, type RegisterSpec } from './registers.js';

/** A device on the bus. Protocol only -- the electrical binding is the attachment's job. */
export interface SpiPeripheral {
  readonly id: string;
  /** CS went active. */
  onSelect?(): void;
  /** One byte exchanged: the master's byte in, this device's byte out. Full duplex, as the wire is. */
  transfer(mosi: number): number;
  /** CS went inactive, which is what ends a command for most devices. */
  onDeselect?(): void;
  /** SPI mode the datasheet requires, 0-3. Undefined means the device tolerates any. */
  readonly mode?: number | undefined;
  /** Bit order the device expects. Almost everything is MSB-first. */
  readonly bitOrder?: 'msbFirst' | 'lsbFirst' | undefined;
  /** Maximum SCK the datasheet allows, hertz. */
  readonly maxClockHz?: number | undefined;
}

/** A peripheral plus the wiring that selects it. */
export interface SpiAttachment {
  readonly peripheral: SpiPeripheral;
  /** Circuit node the device's CS pin is on. */
  readonly csNode: number;
  /** True for the usual active-low CS. */
  readonly csActiveLow: boolean;
}

/** One byte seen on the bus. */
export interface SpiTransfer {
  /** Device that answered, or null when nothing was selected. */
  readonly peripheralId: string | null;
  readonly mosi: number;
  readonly miso: number;
  /** Master's mode and bit order at the moment of transfer, for mismatch reporting. */
  readonly mode: number;
  readonly bitOrder: 'msbFirst' | 'lsbFirst';
}

/** What avr8js's SPI peripheral gives us. Declared structurally, as the TWI host is. */
export interface SpiHost {
  completeTransfer(receivedByte: number): void;
  readonly isMaster: boolean;
  readonly spiMode: 0 | 1 | 2 | 3;
  readonly dataOrder: 'msbFirst' | 'lsbFirst';
  readonly spiFrequency: number;
}

/**
 * What MISO reads when nothing is driving it.
 *
 * An unselected bus leaves MISO high-impedance. Most boards have enough leakage and stray pull-up
 * for it to read high, which is why "SPI returns 0xFF" is the universal symptom of a CS that never
 * went low -- and why returning it here, rather than zero, reproduces the bug people actually see.
 */
const UNDRIVEN_BYTE = 0xff;

/** Voltage below which a CS line counts as asserted, as a fraction of the supply. */
const CS_LOW_FRACTION = 0.3;
const CS_HIGH_FRACTION = 0.6;

/** Something is wrong with how the master is talking to a device. */
export interface SpiProtocolIssue {
  readonly kind: 'no-device-selected' | 'multiple-selected' | 'mode-mismatch' | 'bit-order' | 'clock-too-fast';
  readonly peripheralId: string | null;
  readonly detail: string;
}

export class SpiBus {
  private readonly attachments: SpiAttachment[] = [];
  /** Devices currently selected, recomputed before each transfer. */
  private selected: SpiAttachment[] = [];
  private readonly log: SpiTransfer[] = [];
  private logLimit = 4096;
  /** Issues seen since the last clear, deduplicated by kind and device. */
  private readonly issues = new Map<string, SpiProtocolIssue>();

  constructor(
    private readonly spi: SpiHost,
    /** Voltage at a circuit node, so CS is read from the wire rather than assumed. */
    private readonly nodeVoltage: (node: number) => number,
    private readonly supplyVolts: number,
  ) {}

  attach(attachment: SpiAttachment): void {
    this.attachments.push(attachment);
  }

  detach(peripheralId: string): void {
    const index = this.attachments.findIndex((a) => a.peripheral.id === peripheralId);
    if (index >= 0) this.attachments.splice(index, 1);
  }

  get peripheralIds(): string[] {
    return this.attachments.map((a) => a.peripheral.id);
  }

  get transfers(): readonly SpiTransfer[] {
    return this.log;
  }

  /** Protocol problems observed, for the fault layer. */
  get protocolIssues(): readonly SpiProtocolIssue[] {
    return [...this.issues.values()];
  }

  /** Devices whose CS is currently asserted. */
  get selectedIds(): string[] {
    return this.selected.map((a) => a.peripheral.id);
  }

  clear(): void {
    this.log.length = 0;
    this.selected = [];
    this.issues.clear();
  }

  /**
   * Re-read every CS line and fire select/deselect edges.
   *
   * Called after each analog solve rather than only at transfer time, because a device's command
   * is framed by CS going low and high again -- an SD card counts the bytes between them -- and a
   * deselect that was only noticed at the next transfer would merge two commands into one.
   */
  updateChipSelects(): void {
    const nowSelected: SpiAttachment[] = [];

    for (const attachment of this.attachments) {
      const voltage = this.nodeVoltage(attachment.csNode);
      const wasSelected = this.selected.includes(attachment);
      // Hysteresis around the logic thresholds, so a line sitting mid-rail does not chatter
      // select/deselect on every solve.
      const threshold = wasSelected ? CS_HIGH_FRACTION : CS_LOW_FRACTION;
      const high = voltage > this.supplyVolts * threshold;
      const isSelected = attachment.csActiveLow ? !high : high;

      if (isSelected) nowSelected.push(attachment);
      if (isSelected && !wasSelected) attachment.peripheral.onSelect?.();
      if (!isSelected && wasSelected) attachment.peripheral.onDeselect?.();
    }

    this.selected = nowSelected;
  }

  // --- avr8js SPI handler -----------------------------------------------------------------------

  /**
   * A byte has been written to SPDR.
   *
   * avr8js expects `completeTransfer` within `transferCycles`; calling it immediately is correct
   * for a slave that responds combinatorially, which every register-file device does.
   */
  onByte(mosi: number): void {
    this.updateChipSelects();

    const target = this.selected[0];
    let miso = UNDRIVEN_BYTE;

    if (!target) {
      this.note({
        kind: 'no-device-selected',
        peripheralId: null,
        detail:
          `A byte (0x${mosi.toString(16).padStart(2, '0')}) was clocked out with no chip select ` +
          `asserted. Nothing is listening, and MISO reads back 0x${UNDRIVEN_BYTE.toString(16)}.`,
      });
    } else {
      if (this.selected.length > 1) {
        // Two devices driving MISO at once is a genuine short between two push-pull outputs. The
        // master reads whichever wins, which is why this shows up as intermittent nonsense.
        this.note({
          kind: 'multiple-selected',
          peripheralId: target.peripheral.id,
          detail:
            `${this.selectedIds.join(' and ')} are selected at the same time. Both drive MISO, ` +
            `which shorts their outputs together and corrupts every byte read.`,
        });
      }

      this.checkCompatibility(target.peripheral);
      miso = target.peripheral.transfer(mosi & 0xff) & 0xff;
    }

    this.record({
      peripheralId: target?.peripheral.id ?? null,
      mosi: mosi & 0xff,
      miso,
      mode: this.spi.spiMode,
      bitOrder: this.spi.dataOrder,
    });

    this.spi.completeTransfer(miso);
  }

  /**
   * Compare how the master is clocking against what the device requires.
   *
   * None of this changes the bytes exchanged, which is deliberate: modelling the corruption a mode
   * mismatch causes would mean inventing exactly which bits get sampled wrong, and the useful
   * answer is not corrupted data but a message naming the mismatch. This is the one place a
   * simulator can beat a logic analyser, where mode-3-versus-mode-0 looks like working traffic.
   */
  private checkCompatibility(peripheral: SpiPeripheral): void {
    if (peripheral.mode !== undefined && peripheral.mode !== this.spi.spiMode) {
      this.note({
        kind: 'mode-mismatch',
        peripheralId: peripheral.id,
        detail:
          `${peripheral.id} needs SPI mode ${peripheral.mode} but the sketch is using mode ` +
          `${this.spi.spiMode}. The clock idles at the wrong level or samples on the wrong edge, ` +
          `so every byte it reads is shifted by a bit.`,
      });
    }

    const wanted = peripheral.bitOrder ?? 'msbFirst';
    if (wanted !== this.spi.dataOrder) {
      this.note({
        kind: 'bit-order',
        peripheralId: peripheral.id,
        detail:
          `${peripheral.id} expects ${wanted === 'msbFirst' ? 'MSB' : 'LSB'}-first data but the ` +
          `sketch has set ${this.spi.dataOrder === 'msbFirst' ? 'MSB' : 'LSB'}-first. Every byte ` +
          `arrives bit-reversed.`,
      });
    }

    if (peripheral.maxClockHz !== undefined && this.spi.spiFrequency > peripheral.maxClockHz) {
      this.note({
        kind: 'clock-too-fast',
        peripheralId: peripheral.id,
        detail:
          `SCK is ${formatHz(this.spi.spiFrequency)}, above the ${formatHz(peripheral.maxClockHz)} ` +
          `maximum for ${peripheral.id}. Use a larger SPI clock divider.`,
      });
    }
  }

  private note(issue: SpiProtocolIssue): void {
    this.issues.set(`${issue.kind}:${issue.peripheralId ?? '-'}`, issue);
  }

  private record(transfer: SpiTransfer): void {
    this.log.push(transfer);
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
  }
}

function formatHz(hz: number): string {
  if (hz >= 1e6) return `${(hz / 1e6).toFixed(2)} MHz`;
  if (hz >= 1e3) return `${(hz / 1e3).toFixed(0)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

// ---------------------------------------------------------------------------------------------

/**
 * How a device frames a command.
 *
 * `register` is the near-universal sensor convention: one command byte whose top bit says read or
 * write and whose remaining bits are a register address, then data bytes with the address
 * auto-incrementing. ADXL345, BME280, MPU-9250, L3GD20 and most of their relatives use it, with
 * only the polarity of the read bit differing between them.
 *
 * `stream` is for the parts with no addressing at all -- shift registers, most graphic displays --
 * where the bytes between one CS edge and the next simply are the payload.
 */
export type SpiAddressing = 'register' | 'stream';

export interface SpiRegisterOptions {
  readonly addressing?: SpiAddressing;
  /** Bit in the command byte carrying the read/write flag. */
  readonly readBitPosition?: number;
  /** Value of that bit meaning "read". 1 for most devices; some invert it. */
  readonly readBitValue?: 0 | 1;
  /** Whether the address advances between data bytes. */
  readonly autoIncrement?: boolean;
  readonly mode?: number;
  readonly bitOrder?: 'msbFirst' | 'lsbFirst';
  readonly maxClockHz?: number;
}

/**
 * The SPI counterpart of `RegisterFilePeripheral`.
 *
 * Full duplex is modelled honestly, and it is the detail most people get wrong when they first
 * read an SPI trace: the byte the master receives while it is still sending the command byte is
 * not data. The device has not been told what to fetch yet, so it drives whatever it drives --
 * zero here -- and the requested register only appears on the *next* byte. A sketch that reads one
 * byte per transaction and expects data in it gets nothing, on real hardware and here alike.
 */
export class SpiRegisterPeripheral implements SpiPeripheral {
  private readonly file: RegisterFile;
  private readonly addressing: SpiAddressing;
  private readonly readBitPosition: number;
  private readonly readBitValue: 0 | 1;
  private readonly autoIncrement: boolean;

  readonly mode: number | undefined;
  readonly bitOrder: 'msbFirst' | 'lsbFirst' | undefined;
  readonly maxClockHz: number | undefined;

  private pointer = 0;
  private reading = false;
  private awaitingCommand = true;
  /** Bytes received in the current CS frame, which is the whole payload for a stream device. */
  private frame: number[] = [];
  private lastFrame: number[] = [];

  constructor(
    readonly id: string,
    specs: readonly RegisterSpec[],
    readState: (name: string) => number = () => 0,
    options: SpiRegisterOptions = {},
  ) {
    this.file = new RegisterFile(specs, readState);
    this.addressing = options.addressing ?? 'register';
    this.readBitPosition = options.readBitPosition ?? 7;
    this.readBitValue = options.readBitValue ?? 1;
    this.autoIncrement = options.autoIncrement ?? true;
    this.mode = options.mode;
    this.bitOrder = options.bitOrder;
    this.maxClockHz = options.maxClockHz;
  }

  onSelect(): void {
    // CS falling is what frames a command. A device that kept its pointer across frames would let
    // a sketch that never asserts CS appear to work.
    this.awaitingCommand = true;
    this.frame = [];
  }

  onDeselect(): void {
    this.lastFrame = this.frame;
    this.awaitingCommand = true;
  }

  transfer(mosi: number): number {
    this.frame.push(mosi);

    if (this.addressing === 'stream') {
      // No addressing: the bytes land in consecutive locations and reads return them back.
      const value = this.file.byteAt(this.pointer);
      this.file.write(this.pointer, mosi);
      this.pointer = (this.pointer + 1) & 0xff;
      return value;
    }

    if (this.awaitingCommand) {
      const bit = (mosi >> this.readBitPosition) & 1;
      this.reading = bit === this.readBitValue;
      // The address is the command byte with the read/write bit removed.
      this.pointer = mosi & ~(1 << this.readBitPosition) & 0xff;
      this.awaitingCommand = false;
      return 0x00;
    }

    let out = 0x00;
    if (this.reading) {
      out = this.file.byteAt(this.pointer);
    } else {
      this.file.write(this.pointer, mosi);
    }
    if (this.autoIncrement) this.pointer = (this.pointer + 1) & 0xff;
    return out;
  }

  /** Current value of a named register. */
  read(name: string): number {
    return this.file.read(name);
  }

  /** Every stored byte, for a display's framebuffer. */
  snapshot(): Map<number, number> {
    return this.file.snapshot();
  }

  /** Bytes of the most recently completed CS frame, which is what a stream device is driven by. */
  get lastCommand(): readonly number[] {
    return this.lastFrame;
  }
}
