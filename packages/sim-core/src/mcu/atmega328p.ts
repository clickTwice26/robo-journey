/**
 * ATmega328P machine: the avr8js CPU core plus its full peripheral complement, wired together and
 * given a run loop.
 *
 * This is deliberately *not* an Arduino API emulation. Nothing here knows what `digitalWrite` is.
 * We execute the compiled machine code and observe the port registers, exactly as a logic analyzer
 * clipped to a real chip would. Whatever the sketch does to get a pin high is its own business.
 */
import {
  AVRADC,
  AVRClock,
  AVREEPROM,
  AVRIOPort,
  AVRSPI,
  AVRTimer,
  AVRTWI,
  AVRUSART,
  AVRWatchdog,
  CPU,
  EEPROMMemoryBackend,
  PinState,
  adcConfig,
  atmega328Channels,
  avrInstruction,
  clockConfig,
  eepromConfig,
  portBConfig,
  portCConfig,
  portDConfig,
  spiConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  twiConfig,
  usart0Config,
  watchdogConfig,
} from 'avr8js';
import { UNO_PINS, type PinLocation, type PortId } from './pin-map.js';

/** Stock Arduino Uno clock. */
export const UNO_CLOCK_HZ = 16_000_000;

/** ATmega328P: 2 KiB SRAM, 1 KiB EEPROM. */
const SRAM_BYTES = 2 * 1024;
const EEPROM_BYTES = 1024;

/**
 * How a pin is driving the outside world, resolved from the DDR and PORT register bits.
 *
 * These four states are the entire electrical contract between the MCU and the circuit. In M0 they
 * are observed as logic levels; in M1 each maps to a Thevenin stamp in the analog solver
 * (`High` -> VCC through ~25 ohm, `InputPullUp` -> ~36k to VCC, and so on).
 */
export type PinDriveState = 'low' | 'high' | 'input' | 'input-pullup';

function toDriveState(state: PinState): PinDriveState {
  switch (state) {
    case PinState.Low:
      return 'low';
    case PinState.High:
      return 'high';
    case PinState.InputPullUp:
      return 'input-pullup';
    case PinState.Input:
    default:
      return 'input';
  }
}

export interface PinChange {
  readonly pin: PinLocation;
  readonly state: PinDriveState;
  /** CPU cycle at which the change was observed. */
  readonly cycles: number;
  /** Simulated time in seconds since reset. */
  readonly time: number;
}

export type PinChangeListener = (change: PinChange) => void;
export type SerialListener = (byte: number) => void;

export interface Atmega328pOptions {
  /** Program memory image, from `loadHex`. */
  readonly progMem: Uint16Array;
  readonly clockHz?: number;
}

/**
 * A running ATmega328P.
 *
 * Ownership note: this class owns *time*. `cycles` is the authority, and every other subsystem —
 * the analog solver, the scope, the fault detector — derives its timestamps from here. Keeping one
 * clock is what makes the co-simulation in `sched/` tractable.
 */
export class Atmega328p {
  readonly cpu: CPU;
  readonly clockHz: number;

  readonly portB: AVRIOPort;
  readonly portC: AVRIOPort;
  readonly portD: AVRIOPort;

  readonly timer0: AVRTimer;
  readonly timer1: AVRTimer;
  readonly timer2: AVRTimer;
  readonly usart: AVRUSART;
  readonly adc: AVRADC;
  readonly twi: AVRTWI;
  readonly spi: AVRSPI;
  readonly eeprom: AVREEPROM;
  readonly clock: AVRClock;
  readonly watchdog: AVRWatchdog;

  private readonly ports: Record<PortId, AVRIOPort>;
  private readonly pinListeners = new Set<PinChangeListener>();
  private readonly serialListeners = new Set<SerialListener>();
  /** Last observed drive state per pin label, so we only report genuine transitions. */
  private readonly lastState = new Map<string, PinDriveState>();

  constructor(options: Atmega328pOptions) {
    this.clockHz = options.clockHz ?? UNO_CLOCK_HZ;
    this.cpu = new CPU(options.progMem, SRAM_BYTES);

    this.portB = new AVRIOPort(this.cpu, portBConfig);
    this.portC = new AVRIOPort(this.cpu, portCConfig);
    this.portD = new AVRIOPort(this.cpu, portDConfig);
    this.ports = { B: this.portB, C: this.portC, D: this.portD };

    // timer0 is not optional: the Arduino core builds millis() and delay() on its overflow
    // interrupt. Without it, Blink hangs in an empty loop forever and the failure looks like a CPU
    // bug rather than a missing peripheral.
    this.timer0 = new AVRTimer(this.cpu, timer0Config);
    this.timer1 = new AVRTimer(this.cpu, timer1Config);
    this.timer2 = new AVRTimer(this.cpu, timer2Config);

    this.usart = new AVRUSART(this.cpu, usart0Config, this.clockHz);
    // `adcConfig` already carries the ATmega328 mux map; naming it explicitly documents the
    // channel table that A0-A5 resolve through. `adc.channelValues` (volts) and `adc.avcc` are the
    // seams M1 drives: solved node voltages in, sagging reference during brownout.
    this.adc = new AVRADC(this.cpu, { ...adcConfig, muxChannels: atmega328Channels });
    this.twi = new AVRTWI(this.cpu, twiConfig, this.clockHz);
    this.spi = new AVRSPI(this.cpu, spiConfig, this.clockHz);
    this.eeprom = new AVREEPROM(this.cpu, new EEPROMMemoryBackend(EEPROM_BYTES), eepromConfig);
    this.clock = new AVRClock(this.cpu, this.clockHz, clockConfig);
    this.watchdog = new AVRWatchdog(this.cpu, watchdogConfig, this.clock);

    this.attachPortListeners();
    this.usart.onByteTransmit = (byte: number) => {
      for (const listener of this.serialListeners) listener(byte);
    };

    this.seedPinStates();
  }

  /** CPU cycles executed since reset. */
  get cycles(): number {
    return this.cpu.cycles;
  }

  /** Simulated seconds since reset. */
  get time(): number {
    return this.cpu.cycles / this.clockHz;
  }

  /** Current drive state of a pin, by silkscreen label. */
  pinState(label: string): PinDriveState {
    const pin = UNO_PINS.find((p) => p.label === label.toUpperCase());
    if (!pin) throw new Error(`Unknown pin "${label}"`);
    return toDriveState(this.ports[pin.port].pinState(pin.bit));
  }

  /**
   * Drive a pin's input level from outside the chip.
   *
   * In M0 this is how a test plays the part of the circuit. In M1 the analog solver calls it after
   * comparing the resolved node voltage against VIL/VIH.
   */
  setPinInput(label: string, high: boolean): void {
    const pin = UNO_PINS.find((p) => p.label === label.toUpperCase());
    if (!pin) throw new Error(`Unknown pin "${label}"`);
    this.ports[pin.port].setPin(pin.bit, high);
  }

  onPinChange(listener: PinChangeListener): () => void {
    this.pinListeners.add(listener);
    return () => this.pinListeners.delete(listener);
  }

  onSerialByte(listener: SerialListener): () => void {
    this.serialListeners.add(listener);
    return () => this.serialListeners.delete(listener);
  }

  /** Execute a single instruction, then service clock events. */
  step(): void {
    avrInstruction(this.cpu);
    this.cpu.tick();
  }

  /**
   * Run until the cycle counter reaches `targetCycle`.
   *
   * Cycle-targeted rather than count-targeted because AVR instructions take 1-4 cycles: asking for
   * "1000 cycles" and getting 1003 would let error accumulate across a long run, and the whole point
   * of this project is that the timing is trustworthy.
   */
  runToCycle(targetCycle: number): void {
    while (this.cpu.cycles < targetCycle) this.step();
  }

  /** Run for a span of simulated seconds. */
  runFor(seconds: number): void {
    this.runToCycle(this.cpu.cycles + Math.round(seconds * this.clockHz));
  }

  /** Run for a span of simulated milliseconds. */
  runForMillis(millis: number): void {
    this.runFor(millis / 1000);
  }

  private attachPortListeners(): void {
    for (const [id, port] of Object.entries(this.ports) as [PortId, AVRIOPort][]) {
      port.addListener(() => this.emitPortChanges(id, port));
    }
  }

  /**
   * avr8js reports a whole-port write; we diff it down to the pins that actually moved.
   *
   * Without the diff, a sketch writing PORTB would report all six Uno pins on that port as
   * "changed", which would make the scope, the fault detector and the analog re-stamp all do six
   * times the work they need to.
   */
  private emitPortChanges(id: PortId, port: AVRIOPort): void {
    if (this.pinListeners.size === 0) {
      this.seedPortStates(id, port);
      return;
    }
    const cycles = this.cpu.cycles;
    const time = cycles / this.clockHz;
    for (const pin of UNO_PINS) {
      if (pin.port !== id) continue;
      const state = toDriveState(port.pinState(pin.bit));
      if (this.lastState.get(pin.label) === state) continue;
      this.lastState.set(pin.label, state);
      for (const listener of this.pinListeners) listener({ pin, state, cycles, time });
    }
  }

  private seedPortStates(id: PortId, port: AVRIOPort): void {
    for (const pin of UNO_PINS) {
      if (pin.port !== id) continue;
      this.lastState.set(pin.label, toDriveState(port.pinState(pin.bit)));
    }
  }

  private seedPinStates(): void {
    for (const [id, port] of Object.entries(this.ports) as [PortId, AVRIOPort][]) {
      this.seedPortStates(id, port);
    }
  }
}
