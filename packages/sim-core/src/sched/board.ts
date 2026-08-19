/**
 * The board: an ATmega328P co-simulated with the circuit around it.
 *
 * This is where the two halves meet. The MCU's port registers become electrical stamps, the
 * circuit's node voltages become what the input latches and the ADC read back, and neither side
 * gets to pretend the other is ideal.
 *
 * Scheduling is event-driven, because it has to be. Solving the analog network on every CPU cycle
 * would mean 16 million matrix solves per second. Instead the MCU runs freely until something
 * electrically interesting happens -- a pin changes drive state -- and the network is re-solved
 * then, plus at a bounded interval so reactive components and the ADC stay current.
 */
import { Circuit } from '../analog/circuit.js';
import { GROUND } from '../analog/mna.js';
import { VoltageSource } from '../analog/devices.js';
import { Atmega328p, type Atmega328pOptions } from '../mcu/atmega328p.js';
import { UNO_PINS, type PinLocation } from '../mcu/pin-map.js';
import {
  AvrPin,
  PIN_ABSOLUTE_MAX_CURRENT,
  SUPPLY_ABSOLUTE_MAX_CURRENT,
} from '../mcu/pin-model.js';
import { type Fault, fault, formatCurrent, formatVoltage } from '../faults/index.js';

export interface BoardOptions extends Atmega328pOptions {
  /** Supply voltage. 5 V for a classic Uno, 3.3 V for a 3V3 board. */
  readonly supplyVolts?: number;
  /**
   * Maximum simulated time between analog solves, seconds.
   *
   * A ceiling, not a fixed step: a pin change forces a solve immediately. It exists so that a
   * sketch sitting in `delay()` for a second still lets an RC network charge and the ADC see
   * fresh voltages. 100 us is well under the ADC's ~104 us conversion.
   */
  readonly maxAnalogInterval?: number;
}

const DEFAULT_SUPPLY_VOLTS = 5;
const DEFAULT_MAX_ANALOG_INTERVAL = 100e-6;

export class Board {
  readonly mcu: Atmega328p;
  readonly circuit: Circuit;
  /** The VCC rail, available for wiring parts that need power. */
  readonly vcc: number;
  /** Ground, re-exported so callers need not import it separately. */
  readonly gnd = GROUND;
  readonly supplyVolts: number;

  private readonly supply: VoltageSource;
  private readonly pins = new Map<string, AvrPin>();
  private readonly pinsByLocation: { pin: AvrPin; location: PinLocation }[] = [];
  private readonly maxAnalogInterval: number;

  /** Set by the MCU's pin-change listener; forces an analog solve at the next opportunity. */
  private pinsDirty = true;
  /** Simulated time of the last analog solve, seconds. */
  private lastSolveTime = 0;
  private detectedFaults: Fault[] = [];

  constructor(options: BoardOptions) {
    this.mcu = new Atmega328p(options);
    this.supplyVolts = options.supplyVolts ?? DEFAULT_SUPPLY_VOLTS;
    this.maxAnalogInterval = options.maxAnalogInterval ?? DEFAULT_MAX_ANALOG_INTERVAL;

    this.circuit = new Circuit();
    this.vcc = this.circuit.addNode();
    this.supply = this.circuit.add(new VoltageSource('VCC', this.vcc, GROUND, this.supplyVolts));

    // One circuit node and one pin model per header pin.
    for (const location of UNO_PINS) {
      const node = this.circuit.addNode();
      const pin = new AvrPin(location.label, node, this.vcc);
      this.circuit.add(pin);
      this.pins.set(location.label, pin);
      this.pinsByLocation.push({ pin, location });
    }

    this.mcu.onPinChange(() => {
      this.pinsDirty = true;
    });
  }

  /** The circuit node a header pin is bonded to. Wire parts here. */
  node(label: string): number {
    const pin = this.pins.get(label.toUpperCase());
    if (!pin) throw new Error(`Unknown pin "${label}"`);
    return pin.node;
  }

  /** The pin model for a header pin, for reading current and drive state. */
  pin(label: string): AvrPin {
    const pin = this.pins.get(label.toUpperCase());
    if (!pin) throw new Error(`Unknown pin "${label}"`);
    return pin;
  }

  /** Voltage at a header pin, as a multimeter probe would read it. */
  voltage(label: string): number {
    return this.circuit.voltage(this.node(label));
  }

  /** Current sourced by the supply, amps. */
  get supplyCurrent(): number {
    return this.supply.currentDelivered(this.circuit.system);
  }

  /** Faults observed at the most recent analog solve. */
  get faults(): readonly Fault[] {
    return this.detectedFaults;
  }

  /** Simulated seconds since reset. */
  get time(): number {
    return this.mcu.time;
  }

  /**
   * Run for a span of simulated time.
   *
   * The MCU runs at full speed between electrical events. Each pass advances the CPU to the next
   * checkpoint -- whichever comes first of a pin change, the analog interval, or the end of the
   * requested span -- then re-solves the network and pushes the results back into the chip.
   */
  runFor(seconds: number): void {
    const targetCycle = this.mcu.cycles + Math.round(seconds * this.mcu.clockHz);

    // Establish an operating point before the first instruction, so the very first read sees a
    // settled circuit rather than all-zero nodes.
    this.solveAnalog(0);

    while (this.mcu.cycles < targetCycle) {
      const intervalCycles = Math.max(
        1,
        Math.round(this.maxAnalogInterval * this.mcu.clockHz),
      );
      const checkpoint = Math.min(this.mcu.cycles + intervalCycles, targetCycle);

      this.pinsDirty = false;
      while (this.mcu.cycles < checkpoint && !this.pinsDirty) {
        this.mcu.step();
      }

      const dt = this.mcu.time - this.lastSolveTime;
      if (dt > 0) this.solveAnalog(dt);
    }
  }

  /** Reset the MCU and the circuit to their power-on states. */
  reset(): void {
    this.mcu.cpu.reset();
    this.circuit.reset();
    this.lastSolveTime = 0;
    this.pinsDirty = true;
    this.detectedFaults = [];
  }

  // -------------------------------------------------------------------------------------------

  /**
   * One co-simulation exchange: registers out, voltages in.
   *
   * @param dt Simulated seconds since the previous solve. Zero requests a DC operating point.
   */
  private solveAnalog(dt: number): void {
    let driveChanged = false;

    // 1. MCU port registers become electrical stamps.
    for (const { pin, location } of this.pinsByLocation) {
      const state = this.mcu.pinState(location.label);
      if (pin.driveState !== state) {
        pin.driveState = state;
        driveChanged = true;
      }
    }

    // A pin changing drive state is a genuine discontinuity: the trapezoidal rule must not
    // integrate across it. This is the single most common discontinuity in the whole simulator.
    if (driveChanged) this.circuit.markDiscontinuity();

    // 2. Solve.
    if (dt > 0) {
      this.circuit.step(dt);
    } else {
      this.circuit.solve();
    }
    this.lastSolveTime = this.mcu.time;

    // 3. Node voltages become what the chip reads back.
    const vcc = this.supplyVolts;
    for (const { pin, location } of this.pinsByLocation) {
      const v = this.circuit.voltage(pin.node);

      if (pin.driveState === 'input' || pin.driveState === 'input-pullup') {
        this.mcu.setPinInput(location.label, pin.latchedLevel(v, vcc));
      }

      // The ADC reads volts directly, so a divider's real output lands in ADCH/ADCL -- including
      // the error a too-high source impedance would cause on real hardware.
      if (location.analogChannel !== undefined) {
        this.mcu.adc.channelValues[location.analogChannel] = v;
      }
    }

    // 4. Look for damage.
    this.detectFaults();
  }

  private detectFaults(): void {
    const faults: Fault[] = [];
    const time = this.mcu.time;
    const vcc = this.supplyVolts;
    const mna = this.circuit.system;

    for (const { pin, location } of this.pinsByLocation) {
      const current = pin.current(mna, vcc);
      if (Math.abs(current) > PIN_ABSOLUTE_MAX_CURRENT) {
        faults.push(
          fault(
            'pin-over-current',
            'error',
            location.label,
            `${location.label} is passing ${formatCurrent(current)}, beyond the ` +
              `${formatCurrent(PIN_ABSOLUTE_MAX_CURRENT)} absolute maximum for an I/O pin.`,
            time,
          ),
        );
      }

      const v = this.circuit.voltage(pin.node);
      if (pin.isFloating(v, vcc)) {
        faults.push(
          fault(
            'floating-input',
            'warning',
            location.label,
            `${location.label} is floating at ${formatVoltage(v)}, between VIL ` +
              `(${formatVoltage(0.3 * vcc)}) and VIH (${formatVoltage(0.6 * vcc)}). ` +
              `What it reads is undefined.`,
            time,
          ),
        );
      }
    }

    const supplyCurrent = this.supplyCurrent;
    if (supplyCurrent > SUPPLY_ABSOLUTE_MAX_CURRENT) {
      faults.push(
        fault(
          'supply-over-current',
          'error',
          'VCC',
          `Total draw is ${formatCurrent(supplyCurrent)}, beyond the ` +
            `${formatCurrent(SUPPLY_ABSOLUTE_MAX_CURRENT)} the VCC and GND pins can carry.`,
          time,
        ),
      );
    }

    this.detectedFaults = faults;
  }
}
