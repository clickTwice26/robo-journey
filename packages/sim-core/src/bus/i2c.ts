/**
 * I2C bus.
 *
 * avr8js implements the TWI peripheral's register-level behaviour and hands the bus protocol out
 * through `TWIEventHandler`: it tells us when the master issues a START, which address it is
 * calling, and what bytes it writes, and waits for us to say whether anyone answered. That is the
 * right seam -- the master's timing and status machine stay the peripheral's problem, and ours is
 * only to be a convincing slave.
 *
 * What that does *not* give is the wire. A missing pull-up, the single most common I2C fault,
 * changes nothing at this level: the protocol still completes because nothing is physically
 * driving anything. So the electrical check lives separately, in the fault layer, where the
 * solver can see whether SDA and SCL actually have a path to the rail.
 */

import { RegisterFile, type RegisterSpec } from './registers.js';

/** A device sitting on the bus at one 7-bit address. */
export interface I2cPeripheral {
  /** 7-bit address, without the read/write bit. */
  readonly address: number;
  /** A transaction has begun with this device. `write` is false for a read. */
  onStart?(write: boolean): void;
  /** The master wrote a byte. Return true to acknowledge it, as a real device would. */
  onWrite(byte: number): boolean;
  /** The master is reading. Return the byte to put on the bus. */
  onRead(): number;
  /** The transaction ended. */
  onStop?(): void;
}

/** One byte seen on the bus, for the analyser and for tests. */
export interface I2cTransfer {
  readonly address: number;
  readonly direction: 'read' | 'write';
  readonly byte: number;
  /** False when nobody acknowledged, which is what an absent device looks like. */
  readonly ack: boolean;
}

/**
 * The interface avr8js's TWI expects. Declared structurally rather than imported so `sim-core`'s
 * bus layer does not depend on the emulator's type surface.
 */
export interface TwiHost {
  completeStart(): void;
  completeStop(): void;
  completeConnect(ack: boolean): void;
  completeWrite(ack: boolean): void;
  completeRead(value: number): void;
}

/** Value a device that is not there leaves on the bus: the pull-ups hold it high. */
const FLOATING_BYTE = 0xff;

export class I2cBus {
  private readonly peripherals = new Map<number, I2cPeripheral>();
  private active: I2cPeripheral | null = null;
  private writing = true;
  /** Address of the most recent connect attempt, even when nobody answered. */
  private lastAddress = -1;
  private readonly log: I2cTransfer[] = [];
  private logLimit = 4096;

  constructor(private readonly twi: TwiHost) {}

  /**
   * Put a device on the bus.
   *
   * Two devices at one address is a real and confusing hardware fault -- both answer, and the
   * master reads the wired-AND of their responses. Rejecting it here surfaces the collision at
   * build time instead, when it can still be fixed.
   */
  attach(peripheral: I2cPeripheral): void {
    const existing = this.peripherals.get(peripheral.address);
    if (existing && existing !== peripheral) {
      throw new Error(
        `Two devices share I2C address 0x${peripheral.address.toString(16)}. ` +
          `On real hardware both would answer at once and the master would read nonsense.`,
      );
    }
    this.peripherals.set(peripheral.address, peripheral);
  }

  detach(address: number): void {
    this.peripherals.delete(address);
    if (this.active?.address === address) this.active = null;
  }

  /** Addresses currently answering. */
  get addresses(): number[] {
    return [...this.peripherals.keys()].sort((a, b) => a - b);
  }

  /** Bytes seen on the bus, oldest first. */
  get transfers(): readonly I2cTransfer[] {
    return this.log;
  }

  /** Address of the last device the master called, whether or not it answered. */
  get lastAddressed(): number {
    return this.lastAddress;
  }

  clear(): void {
    this.log.length = 0;
    this.active = null;
    this.lastAddress = -1;
  }

  // --- TWIEventHandler --------------------------------------------------------------------------

  start(_repeated: boolean): void {
    this.twi.completeStart();
  }

  stop(): void {
    this.active?.onStop?.();
    this.active = null;
    this.twi.completeStop();
  }

  connectToSlave(address: number, write: boolean): void {
    this.lastAddress = address;
    const peripheral = this.peripherals.get(address);
    this.active = peripheral ?? null;
    this.writing = write;

    if (peripheral) peripheral.onStart?.(write);
    // No device at that address means no acknowledgement -- which is exactly how a sketch scanning
    // the bus finds out what is connected.
    this.twi.completeConnect(peripheral !== undefined);
  }

  writeByte(value: number): void {
    const ack = this.active ? this.active.onWrite(value) : false;
    this.record(this.lastAddress, 'write', value, ack);
    this.twi.completeWrite(ack);
  }

  readByte(_ack: boolean): void {
    const value = this.active ? this.active.onRead() : FLOATING_BYTE;
    this.record(this.lastAddress, 'read', value, this.active !== null);
    this.twi.completeRead(value);
  }

  private record(address: number, direction: 'read' | 'write', byte: number, ack: boolean): void {
    this.log.push({ address, direction, byte, ack });
    // Bounded: a display refreshing continuously would otherwise fill memory with framebuffer
    // writes nobody is going to read back.
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
  }
}

// ---------------------------------------------------------------------------------------------

export type { RegisterSpec } from './registers.js';

/**
 * The register-file peripheral almost every I2C breakout actually is.
 *
 * The convention: the master writes a register address, then either writes bytes into consecutive
 * registers or reads them back, with the pointer auto-incrementing. MPU-6050, BMP280, the whole
 * family of sensor breakouts speak it. A register can be backed by a state variable, which is how
 * a simulated thermometer returns the temperature the user chose rather than a stored constant.
 */
export class RegisterFilePeripheral implements I2cPeripheral {
  private readonly file: RegisterFile;
  /** Auto-incrementing pointer, as the hardware keeps. */
  private pointer = 0;
  /** True until the first byte of a write transaction has been taken as the pointer. */
  private awaitingPointer = true;

  constructor(
    readonly address: number,
    specs: readonly RegisterSpec[],
    readState: (name: string) => number = () => 0,
  ) {
    this.file = new RegisterFile(specs, readState);
  }

  onStart(write: boolean): void {
    // Only a write transaction begins by setting the pointer; a read continues from wherever the
    // previous one left it, which is what makes the write-then-read idiom work.
    if (write) this.awaitingPointer = true;
  }

  onWrite(byte: number): boolean {
    if (this.awaitingPointer) {
      this.pointer = byte;
      this.awaitingPointer = false;
      return true;
    }

    this.file.write(this.pointer, byte);
    this.pointer = (this.pointer + 1) & 0xff;
    return true;
  }

  onRead(): number {
    const value = this.file.byteAt(this.pointer);
    this.pointer = (this.pointer + 1) & 0xff;
    return value;
  }

  /** Current value of a named register, for tests and the inspector. */
  read(name: string): number {
    return this.file.read(name);
  }

  /** Every byte the master has written, for a display's framebuffer. */
  snapshot(): Map<number, number> {
    return this.file.snapshot();
  }
}
