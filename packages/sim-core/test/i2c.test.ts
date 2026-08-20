/**
 * I2C.
 *
 * The end-to-end test runs a real sketch using `Wire.h` -- scanning the bus, writing a register
 * pointer, reading two bytes back -- against a peripheral defined only by a register table. If the
 * number the sketch prints is the number the peripheral was told to report, every layer between
 * agrees.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Board, I2cBus, RegisterFilePeripheral, Resistor, loadHex } from '../src/index.js';
import type { I2cPeripheral, TwiHost } from '../src/bus/i2c.js';

const i2cHex = readFileSync(
  fileURLToPath(new URL('./fixtures/i2c.hex', import.meta.url)),
  'utf8',
);

/** Stand-in for avr8js's TWI, recording what the bus told it. */
function fakeTwi() {
  const calls: string[] = [];
  const host: TwiHost & { calls: string[]; lastRead: number; lastAck: boolean } = {
    calls,
    lastRead: -1,
    lastAck: false,
    completeStart: () => calls.push('start'),
    completeStop: () => calls.push('stop'),
    completeConnect: (ack) => {
      host.lastAck = ack;
      calls.push(`connect:${ack}`);
    },
    completeWrite: (ack) => {
      host.lastAck = ack;
      calls.push(`write:${ack}`);
    },
    completeRead: (value) => {
      host.lastRead = value;
      calls.push(`read:${value}`);
    },
  };
  return host;
}

const spec = (address: number, name: string, over: Partial<Parameters<typeof RegisterFilePeripheral>[1][number]> = {}) => ({
  address,
  name,
  reset: 0,
  access: 'rw' as const,
  scale: 1,
  offset: 0,
  bytes: 1,
  ...over,
});

describe('I2cBus', () => {
  it('acknowledges an address a device answers at', () => {
    const twi = fakeTwi();
    const bus = new I2cBus(twi);
    bus.attach(new RegisterFilePeripheral(0x48, [spec(0, 'DATA')]));

    bus.connectToSlave(0x48, true);
    expect(twi.lastAck).toBe(true);
  });

  it('does not acknowledge an empty address', () => {
    // This is how a bus scan finds out what is connected -- silence is the answer.
    const twi = fakeTwi();
    const bus = new I2cBus(twi);
    bus.connectToSlave(0x50, true);
    expect(twi.lastAck).toBe(false);
  });

  it('reads 0xFF from an empty address, as the pull-ups leave it', () => {
    const twi = fakeTwi();
    const bus = new I2cBus(twi);
    bus.connectToSlave(0x50, false);
    bus.readByte(true);
    expect(twi.lastRead).toBe(0xff);
  });

  it('refuses two devices at one address', () => {
    // On real hardware both answer at once and the master reads the wired-AND of their replies,
    // which is far more confusing than an error here.
    const bus = new I2cBus(fakeTwi());
    bus.attach(new RegisterFilePeripheral(0x48, []));
    expect(() => bus.attach(new RegisterFilePeripheral(0x48, []))).toThrow(/share I2C address/);
  });

  it('lists the addresses currently answering', () => {
    const bus = new I2cBus(fakeTwi());
    bus.attach(new RegisterFilePeripheral(0x3c, []));
    bus.attach(new RegisterFilePeripheral(0x48, []));
    expect(bus.addresses).toEqual([0x3c, 0x48]);
  });

  it('logs the traffic, for the analyser', () => {
    const twi = fakeTwi();
    const bus = new I2cBus(twi);
    bus.attach(new RegisterFilePeripheral(0x48, [spec(0, 'DATA', { reset: 0xab })]));

    bus.connectToSlave(0x48, true);
    bus.writeByte(0x00);
    bus.connectToSlave(0x48, false);
    bus.readByte(true);

    expect(bus.transfers).toHaveLength(2);
    expect(bus.transfers[0]).toMatchObject({ direction: 'write', byte: 0x00, ack: true });
    expect(bus.transfers[1]).toMatchObject({ direction: 'read', byte: 0xab, ack: true });
  });

  it('detaching stops a device answering', () => {
    const twi = fakeTwi();
    const bus = new I2cBus(twi);
    bus.attach(new RegisterFilePeripheral(0x48, []));
    bus.detach(0x48);
    bus.connectToSlave(0x48, true);
    expect(twi.lastAck).toBe(false);
  });
});

describe('RegisterFilePeripheral', () => {
  function talk(peripheral: I2cPeripheral, writes: number[], reads: number): number[] {
    peripheral.onStart?.(true);
    for (const byte of writes) peripheral.onWrite(byte);
    if (reads > 0) peripheral.onStart?.(false);
    return Array.from({ length: reads }, () => peripheral.onRead());
  }

  it('takes the first byte of a write as the register pointer', () => {
    const device = new RegisterFilePeripheral(0x48, [spec(0, 'A', { reset: 0x11 }), spec(1, 'B', { reset: 0x22 })]);
    expect(talk(device, [0x01], 1)).toEqual([0x22]);
  });

  it('auto-increments the pointer across a burst read', () => {
    // The convention every sensor breakout uses: point once, read a run of registers.
    const device = new RegisterFilePeripheral(0x48, [
      spec(0, 'A', { reset: 0x11 }),
      spec(1, 'B', { reset: 0x22 }),
      spec(2, 'C', { reset: 0x33 }),
    ]);
    expect(talk(device, [0x00], 3)).toEqual([0x11, 0x22, 0x33]);
  });

  it('writes into consecutive registers', () => {
    const device = new RegisterFilePeripheral(0x48, [spec(0, 'A'), spec(1, 'B')]);
    talk(device, [0x00, 0xde, 0xad], 0);
    expect(device.read('A')).toBe(0xde);
    expect(device.read('B')).toBe(0xad);
  });

  it('acknowledges a write to a read-only register but discards it', () => {
    // What the hardware does: no error, no effect.
    const device = new RegisterFilePeripheral(0x48, [spec(0, 'RO', { access: 'r', reset: 0x55 })]);
    talk(device, [0x00, 0xff], 0);
    expect(device.read('RO')).toBe(0x55);
  });

  it('continues a read from where the previous write left the pointer', () => {
    // The write-then-read idiom: point in one transaction, read in the next.
    const device = new RegisterFilePeripheral(0x48, [spec(0, 'A', { reset: 1 }), spec(1, 'B', { reset: 2 })]);
    device.onStart?.(true);
    device.onWrite(0x01);
    device.onStart?.(false);
    expect(device.onRead()).toBe(2);
  });

  it('backs a register with a state variable', () => {
    // How a simulated thermometer returns the temperature the user chose rather than a constant.
    let celsius = 25;
    const device = new RegisterFilePeripheral(
      0x48,
      [spec(0, 'TEMP', { fromState: 'temperatureC', scale: 16, bytes: 2 })],
      () => celsius,
    );

    expect(talk(device, [0x00], 2)).toEqual([0x01, 0x90]); // 25 * 16 = 400 = 0x0190

    celsius = -10;
    expect(talk(device, [0x00], 2)).toEqual([0xff, 0x60]); // -160 in two's complement
  });

  it('reads a multi-byte register big-endian, as sensors report', () => {
    const device = new RegisterFilePeripheral(0x48, [spec(0, 'W', { reset: 0x1234, bytes: 2 })]);
    expect(talk(device, [0x00], 2)).toEqual([0x12, 0x34]);
  });
});

describe('a real Wire.h sketch talking to a register file', () => {
  /** Uno with pull-ups on SDA/SCL and a sensor at 0x48 reporting a chosen value. */
  function i2cBoard(value: number) {
    const board = new Board({ progMem: loadHex(i2cHex) });

    // 4.7k pull-ups, as every I2C bus needs.
    board.circuit.add(new Resistor('Rsda', board.node('A4'), board.vcc, 4700));
    board.circuit.add(new Resistor('Rscl', board.node('A5'), board.vcc, 4700));

    board.i2c.attach(
      new RegisterFilePeripheral(
        0x48,
        [{ address: 0, name: 'TEMP', reset: 0, access: 'r', fromState: 'v', scale: 1, offset: 0, bytes: 2 }],
        () => value,
      ),
    );
    return board;
  }

  function output(board: Board, seconds: number): string {
    let text = '';
    board.mcu.onSerialByte((byte) => {
      text += String.fromCharCode(byte);
    });
    board.runFor(seconds);
    return text;
  }

  it('finds the device when the sketch scans the bus', () => {
    // The scan is real: the sketch addresses every address in turn and only 0x48 acknowledges.
    const board = i2cBoard(1234);
    const text = output(board, 0.5);
    expect(text).toMatch(/found:.*0x48/);
  });

  it('reads back the value the peripheral was told to report', () => {
    const board = i2cBoard(1234);
    const text = output(board, 0.5);
    // The whole chain: Wire.write sets the pointer, Wire.requestFrom reads two bytes, the sketch
    // reassembles them, and the number that comes out is the one the register was backed with.
    expect(text).toContain('t=1234');
  });

  it('tracks a changing value', () => {
    for (const value of [0, 500, 9999]) {
      const board = i2cBoard(value);
      expect(output(board, 0.4)).toContain(`t=${value}`);
    }
  });

  it('records the traffic on the bus', () => {
    const board = i2cBoard(77);
    output(board, 0.3);

    const transfers = board.i2c.transfers;
    expect(transfers.length).toBeGreaterThan(0);
    expect(transfers.some((t) => t.direction === 'write' && t.byte === 0x00)).toBe(true);
    expect(transfers.some((t) => t.direction === 'read')).toBe(true);
  });

  it('reports a missing pull-up, which the protocol layer cannot see', () => {
    // The classic "my I2C device is not detected". Without pull-ups the transaction still
    // completes in simulation and the bus looks dead on an analyser -- so the check has to be
    // electrical, not protocol-level.
    const board = new Board({ progMem: loadHex(i2cHex) });
    board.i2c.attach(new RegisterFilePeripheral(0x48, []));
    board.runFor(0.2);

    const fault = board.faults.find((f) => f.code === 'i2c-no-pullup');
    expect(fault).toBeDefined();
    expect(fault!.message).toMatch(/pull-ups/);
    expect(fault!.message).toMatch(/4.7/);
  });

  it('raises no pull-up fault when they are fitted', () => {
    const board = i2cBoard(1);
    board.runFor(0.2);
    expect(board.faults.filter((f) => f.code === 'i2c-no-pullup')).toEqual([]);
  });
});
