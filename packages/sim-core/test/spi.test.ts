/**
 * SPI.
 *
 * The end-to-end test runs a real sketch using `SPI.h` against a peripheral defined only by a
 * register table, wired through a chip-select pin the sketch drives itself. That last part is what
 * makes SPI different to test: nothing on the bus says who is being addressed, so the routing is
 * only right if the simulated CS pin is really at the voltage the sketch put it at.
 *
 * The sketch also does one transfer with CS left high on purpose, because "SPI returns 0xFF" is
 * the single most common symptom people bring to a forum and a simulator that quietly answered
 * anyway would be no help at all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Board, SpiBus, SpiRegisterPeripheral, loadHex } from '../src/index.js';
import type { RegisterSpec, SpiHost, SpiPeripheral } from '../src/index.js';

const spiHex = readFileSync(fileURLToPath(new URL('./fixtures/spi.hex', import.meta.url)), 'utf8');
const spiSsHex = readFileSync(fileURLToPath(new URL('./fixtures/spi-ss.hex', import.meta.url)), 'utf8');

/** Stand-in for avr8js's SPI peripheral, recording what came back. */
function fakeSpi(over: Partial<SpiHost> = {}) {
  const host: SpiHost & { received: number[] } = {
    received: [],
    isMaster: true,
    spiMode: 0,
    dataOrder: 'msbFirst',
    spiFrequency: 4e6,
    completeTransfer: (byte: number) => host.received.push(byte),
    ...over,
  };
  return host;
}

const spec = (address: number, name: string, over: Partial<RegisterSpec> = {}): RegisterSpec => ({
  address,
  name,
  reset: 0,
  access: 'rw',
  scale: 1,
  offset: 0,
  bytes: 1,
  ...over,
});

/** A bus whose chip-select lines are held at whatever the test says. */
function busWith(csVolts: Record<number, number>, host = fakeSpi()) {
  const bus = new SpiBus(host, (node) => csVolts[node] ?? 5, 5);
  return { bus, host };
}

describe('SpiBus', () => {
  it('routes a byte to the device whose chip select is low', () => {
    const { bus, host } = busWith({ 1: 0 });
    const device = new SpiRegisterPeripheral('U1', [spec(0x00, 'ID', { reset: 0xe5, access: 'r' })]);
    bus.attach({ peripheral: device, csNode: 1, csActiveLow: true });

    bus.onByte(0x80); // read register 0
    bus.onByte(0x00); // clock the answer out
    expect(host.received).toEqual([0x00, 0xe5]);
  });

  it('answers 0xFF when nothing is selected, and says so', () => {
    // The classic. Everything is wired correctly, the sketch simply never pulled CS low, and the
    // bus looks perfectly healthy on an analyser.
    const { bus, host } = busWith({ 1: 5 });
    bus.attach({
      peripheral: new SpiRegisterPeripheral('U1', [spec(0, 'ID', { reset: 0xe5 })]),
      csNode: 1,
      csActiveLow: true,
    });

    bus.onByte(0x80);
    bus.onByte(0x00);
    expect(host.received).toEqual([0xff, 0xff]);

    const issue = bus.protocolIssues.find((i) => i.kind === 'no-device-selected');
    expect(issue).toBeDefined();
    expect(issue!.detail).toContain('no chip select');
  });

  it('picks the right device out of several', () => {
    const { bus, host } = busWith({ 1: 5, 2: 0 });
    bus.attach({
      peripheral: new SpiRegisterPeripheral('U1', [spec(0, 'ID', { reset: 0x11 })]),
      csNode: 1,
      csActiveLow: true,
    });
    bus.attach({
      peripheral: new SpiRegisterPeripheral('U2', [spec(0, 'ID', { reset: 0x22 })]),
      csNode: 2,
      csActiveLow: true,
    });

    bus.onByte(0x80);
    bus.onByte(0x00);
    expect(host.received[1]).toBe(0x22);
    expect(bus.selectedIds).toEqual(['U2']);
  });

  it('reports two devices selected at once', () => {
    // Two push-pull MISO outputs driving the same wire: a short, and a real one.
    const { bus } = busWith({ 1: 0, 2: 0 });
    for (const [id, node] of [['U1', 1], ['U2', 2]] as const) {
      bus.attach({
        peripheral: new SpiRegisterPeripheral(id, [spec(0, 'ID')]),
        csNode: node,
        csActiveLow: true,
      });
    }

    bus.onByte(0x00);
    const issue = bus.protocolIssues.find((i) => i.kind === 'multiple-selected');
    expect(issue).toBeDefined();
    expect(issue!.detail).toContain('U1 and U2');
  });

  it('honours an active-high chip select', () => {
    const { bus, host } = busWith({ 1: 5 });
    bus.attach({
      peripheral: new SpiRegisterPeripheral('U1', [spec(0, 'ID', { reset: 0x42 })]),
      csNode: 1,
      csActiveLow: false,
    });

    bus.onByte(0x80);
    bus.onByte(0x00);
    expect(host.received[1]).toBe(0x42);
  });

  describe('compatibility checks', () => {
    /** A device that wants mode 3, MSB first, at no more than 5 MHz. */
    const fussy = (): SpiPeripheral => ({
      id: 'ADXL345',
      mode: 3,
      bitOrder: 'msbFirst',
      maxClockHz: 5e6,
      transfer: () => 0,
    });

    function run(over: Partial<SpiHost>) {
      const { bus } = busWith({ 1: 0 }, fakeSpi(over));
      bus.attach({ peripheral: fussy(), csNode: 1, csActiveLow: true });
      bus.onByte(0x00);
      return bus.protocolIssues;
    }

    it('catches a mode mismatch', () => {
      // The bug with no symptom. Wiring is right, the analyser shows clean traffic, and the part
      // returns zeros because the clock idles at the wrong level.
      const issue = run({ spiMode: 0 }).find((i) => i.kind === 'mode-mismatch');
      expect(issue).toBeDefined();
      expect(issue!.detail).toContain('mode 3');
      expect(issue!.detail).toContain('mode 0');
    });

    it('passes a matching mode', () => {
      expect(run({ spiMode: 3 }).some((i) => i.kind === 'mode-mismatch')).toBe(false);
    });

    it('catches reversed bit order', () => {
      const issue = run({ spiMode: 3, dataOrder: 'lsbFirst' }).find((i) => i.kind === 'bit-order');
      expect(issue).toBeDefined();
      expect(issue!.detail).toContain('bit-reversed');
    });

    it('catches a clock the device cannot follow', () => {
      const issue = run({ spiMode: 3, spiFrequency: 8e6 }).find((i) => i.kind === 'clock-too-fast');
      expect(issue).toBeDefined();
      expect(issue!.detail).toContain('8.00 MHz');
      expect(issue!.detail).toContain('5.00 MHz');
    });

    it('is quiet at a clock the device allows', () => {
      expect(run({ spiMode: 3, spiFrequency: 1e6 }).some((i) => i.kind === 'clock-too-fast')).toBe(false);
    });
  });
});

describe('SpiRegisterPeripheral', () => {
  const device = () =>
    new SpiRegisterPeripheral('U1', [
      spec(0x00, 'ID', { reset: 0xe5, access: 'r' }),
      spec(0x2d, 'CTRL'),
      spec(0x32, 'DATA', { access: 'r', fromState: 'v', scale: 256, bytes: 2 }),
    ], () => -1.5);

  it('answers a read one byte after the command, as the wire does', () => {
    // Full duplex means the byte returned alongside the command byte cannot be data: the device
    // has not been told what to fetch yet. A sketch expecting data in that byte gets nothing.
    const u = device();
    u.onSelect();
    expect(u.transfer(0x80)).toBe(0x00);
    expect(u.transfer(0x00)).toBe(0xe5);
  });

  it('writes when the read bit is clear', () => {
    const u = device();
    u.onSelect();
    u.transfer(0x2d);
    u.transfer(0x08);
    expect(u.read('CTRL')).toBe(0x08);
  });

  it('refuses to write a read-only register', () => {
    const u = device();
    u.onSelect();
    u.transfer(0x00);
    u.transfer(0x99);
    expect(u.read('ID')).toBe(0xe5);
  });

  it('auto-increments across a multi-byte read', () => {
    const u = device();
    u.onSelect();
    u.transfer(0xb2); // read 0x32
    const hi = u.transfer(0x00);
    const lo = u.transfer(0x00);
    // -1.5 g at 256 counts per g is -384, which is 0xFE80 in two's complement.
    expect((hi << 8) | lo).toBe(0xfe80);
  });

  it('starts a fresh command on each chip select', () => {
    // Framing is CS, not byte count. A device that kept its pointer would let a sketch that never
    // toggles CS appear to work.
    const u = device();
    u.onSelect();
    u.transfer(0x80);
    u.onDeselect();
    u.onSelect();
    // Without the reset this byte would be taken as data for register 0.
    expect(u.transfer(0xad)).toBe(0x00);
    expect(u.transfer(0x00)).toBe(0x00); // register 0x2D, still empty
  });

  it('takes every byte as payload in stream mode', () => {
    // What a shift register or a graphic display needs: no addressing at all.
    const u = new SpiRegisterPeripheral('595', [spec(0, 'OUT')], () => 0, { addressing: 'stream' });
    u.onSelect();
    u.transfer(0xa5);
    u.onDeselect();
    expect(u.lastCommand).toEqual([0xa5]);
    expect(u.snapshot().get(0)).toBe(0xa5);
  });

  it('honours an inverted read bit', () => {
    const u = new SpiRegisterPeripheral('X', [spec(0x00, 'ID', { reset: 0x7e, access: 'r' })], () => 0, {
      readBitValue: 0,
    });
    u.onSelect();
    u.transfer(0x00); // read, on this part
    expect(u.transfer(0x00)).toBe(0x7e);
  });
});

// ---------------------------------------------------------------------------------------------

describe('a sketch talking to an SPI device', () => {
  /** The sketch drives CS on D9 and uses the hardware SPI pins for everything else. */
  function spiBoard(z: number) {
    const board = new Board({ progMem: loadHex(spiHex) });
    board.spi.attach({
      peripheral: new SpiRegisterPeripheral(
        'ADXL345',
        [
          spec(0x00, 'DEVID', { reset: 0xe5, access: 'r' }),
          spec(0x2d, 'POWER_CTL'),
          spec(0x36, 'DATAZ', { access: 'r', fromState: 'z', scale: 256, bytes: 2 }),
        ],
        () => z,
        { mode: 3, maxClockHz: 5e6 },
      ),
      csNode: board.node('D9'),
      csActiveLow: true,
    });
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

  it('reads the device ID through the whole stack', () => {
    // Compiled SPI.h, avr8js's SPI peripheral, a chip-select pin at a real voltage, and a register
    // table. If 0xE5 comes out, every layer agrees.
    const text = output(spiBoard(0), 0.3);
    expect(text).toContain('id=E5');
  });

  it('reads back what the sketch wrote', () => {
    const text = output(spiBoard(0), 0.3);
    expect(text).toContain('pwr=8');
  });

  it('returns 0xFF for the transfer with chip select left high', () => {
    // The deliberate mistake in the fixture. Nothing is listening, so nothing answers.
    const text = output(spiBoard(0), 0.3);
    expect(text).toContain('nocs=FF');
  });

  it('raises a fault for the unselected transfer', () => {
    const board = spiBoard(0);
    board.runFor(0.3);
    const fault = board.faults.find((f) => f.code === 'spi-no-device-selected');
    expect(fault).toBeDefined();
    expect(fault!.message).toContain('no chip select');
  });

  it('reports the value the state variable was set to', () => {
    const text = output(spiBoard(1), 0.3);
    // 1 g at 256 counts per g, read as two consecutive single-byte reads and reassembled.
    expect(text).toContain('z=256');
  });

  it('does not complain when mode and clock match', () => {
    const board = spiBoard(0);
    board.runFor(0.3);
    expect(board.faults.some((f) => f.code === 'spi-mode-mismatch')).toBe(false);
    expect(board.faults.some((f) => f.code === 'spi-clock-too-fast')).toBe(false);
  });

  it('does not cry wolf about D10 in a sketch that sets it up properly', () => {
    // The fixture calls pinMode(10, OUTPUT) as every SPI sketch should. Before this was gated on
    // the SPI actually being a master, every sketch tripped it during the microseconds between
    // reset and setup() -- and faults latch, so the false positive never went away.
    const board = spiBoard(0);
    board.runFor(0.3);
    expect(board.faults.some((f) => f.code === 'spi-ss-is-input')).toBe(false);
  });

  it('catches D10 taken back as an input while SPI is master', () => {
    // A realistic mistake: pin 10 looks like any other spare pin, and using it for a button
    // silently stops the ATmega328P being an SPI master. Nothing on the bus explains why.
    const board = new Board({ progMem: loadHex(spiSsHex) });
    board.spi.attach({
      peripheral: new SpiRegisterPeripheral('ADXL345', [spec(0, 'DEVID', { reset: 0xe5, access: 'r' })], () => 0, {
        mode: 3,
      }),
      csNode: board.node('D9'),
      csActiveLow: true,
    });
    board.runFor(0.3);

    const fault = board.faults.find((f) => f.code === 'spi-ss-is-input');
    expect(fault).toBeDefined();
    expect(fault!.message).toContain('clears MSTR');
    expect(fault!.message).toMatch(/sits at [\d.]+ V/);
  });

  it('catches the sketch using the wrong SPI mode', () => {
    // Same wiring, same sketch, a device that needs a mode it is not being given. On a bench this
    // is hours of staring at a logic analyser showing perfectly healthy traffic.
    const board = new Board({ progMem: loadHex(spiHex) });
    board.spi.attach({
      peripheral: new SpiRegisterPeripheral('MAX31855', [spec(0, 'T', { reset: 0x42, access: 'r' })], () => 0, {
        mode: 0,
      }),
      csNode: board.node('D9'),
      csActiveLow: true,
    });
    board.runFor(0.3);

    const fault = board.faults.find((f) => f.code === 'spi-mode-mismatch');
    expect(fault).toBeDefined();
    expect(fault!.message).toContain('mode 0');
  });
});
