/**
 * Co-simulation: real firmware driving a real circuit.
 *
 * Everything below runs compiled AVR machine code against the MNA solver. No stubs, no
 * logic-level shortcuts -- the sketch toggles a port register, that becomes a 25 ohm path to the
 * rail, the solver works out what the LED does about it, and the answer comes back as a voltage.
 *
 * This is the file that justifies the project. Each test here is something Wokwi cannot tell you.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Board, GROUND, Led, Resistor, loadHex } from '../src/index.js';

const blinkHex = readFileSync(
  fileURLToPath(new URL('./fixtures/blink.hex', import.meta.url)),
  'utf8',
);
const pullupHex = readFileSync(
  fileURLToPath(new URL('./fixtures/pullup.hex', import.meta.url)),
  'utf8',
);

function blinkBoard(): Board {
  return new Board({ progMem: loadHex(blinkHex) });
}

/** Firmware that does `pinMode(2, INPUT_PULLUP)` and mirrors the button to the built-in LED. */
function pullupBoard(): Board {
  return new Board({ progMem: loadHex(pullupHex) });
}

describe('Board co-simulation', () => {
  describe('Blink driving an LED through a series resistor', () => {
    /** D13 -> 220R -> LED -> GND, the circuit in every starter kit. */
    function ledOnD13(ohms = 220) {
      const board = blinkBoard();
      const anode = board.circuit.addNode();
      board.circuit.add(new Resistor('R1', board.node('D13'), anode, ohms));
      const led = board.circuit.add(new Led('D1', anode, GROUND, 'red'));
      return { board, led };
    }

    it('lights the LED while the sketch holds D13 high', () => {
      const { board, led } = ledOnD13();
      // Blink raises D13 within ~15 us of reset and holds it for 500 ms.
      board.runFor(0.05);

      expect(board.mcu.pinState('D13')).toBe('high');
      expect(led.brightness).toBeGreaterThan(0.5);
      expect(led.current).toBeGreaterThan(0.01);
    });

    it('darkens the LED when the sketch drives D13 low', () => {
      const { board, led } = ledOnD13();
      // 600 ms in, Blink has been low for 100 ms.
      board.runFor(0.6);

      expect(board.mcu.pinState('D13')).toBe('low');
      expect(led.brightness).toBe(0);
      expect(led.current).toBeLessThan(1e-6);
    });

    it('drops real volts across the pin driver, not an ideal zero', () => {
      // The whole point of an electrical model: a driven pin is not exactly at VCC. ~14 mA
      // through the output stage's ~25 ohm costs about a third of a volt, and a real Uno
      // measures the same. A logic-level simulator would report a clean 5.00 V here.
      const { board } = ledOnD13();
      board.runFor(0.05);

      const pinVoltage = board.voltage('D13');
      expect(pinVoltage).toBeLessThan(4.9);
      expect(pinVoltage).toBeGreaterThan(4.5);
    });

    it('closes KVL from the rail through the pin, resistor and LED', () => {
      const { board, led } = ledOnD13();
      board.runFor(0.05);

      const pinV = board.voltage('D13');
      const anodeV = pinV - led.current * 220;
      // Supply = driver drop + resistor drop + LED drop, to within a microvolt.
      expect(5 - pinV + (pinV - anodeV) + led.forwardVoltage).toBeCloseTo(5, 6);
      expect(anodeV).toBeCloseTo(led.forwardVoltage, 6);
    });

    it('raises no faults for a properly resistored LED', () => {
      const { board } = ledOnD13(220);
      board.runFor(0.05);
      expect(board.faults).toEqual([]);
    });

    it('reports pin over-current when the series resistor is missing', () => {
      // The fault the project exists to catch. Wired straight from D13 to an LED, the pin drives
      // far past its 40 mA absolute maximum -- and on a real board this is how you kill a pin.
      const board = blinkBoard();
      const led = board.circuit.add(new Led('D1', board.node('D13'), GROUND, 'red'));
      board.runFor(0.05);

      const overCurrent = board.faults.find((f) => f.code === 'pin-over-current');
      expect(overCurrent).toBeDefined();
      expect(overCurrent!.subject).toBe('D13');
      expect(overCurrent!.severity).toBe('error');
      // The message must carry the measured number, not just an adjective.
      expect(overCurrent!.message).toMatch(/mA/);
      expect(led.current).toBeGreaterThan(0.04);
    });

    it('draws less current through a larger resistor, and dims accordingly', () => {
      const bright = ledOnD13(220);
      const dim = ledOnD13(2200);
      bright.board.runFor(0.05);
      dim.board.runFor(0.05);

      expect(dim.led.current).toBeLessThan(bright.led.current);
      expect(dim.led.brightness).toBeLessThan(bright.led.brightness);
      expect(dim.led.brightness).toBeGreaterThan(0);
    });

    it('tracks the LED through a full blink cycle', () => {
      const { board, led } = ledOnD13();
      const samples: { high: boolean; lit: boolean }[] = [];

      for (let i = 0; i < 5; i++) {
        board.runFor(0.25);
        samples.push({
          high: board.mcu.pinState('D13') === 'high',
          lit: led.brightness > 0.1,
        });
      }

      // Lit exactly when the pin is driven high -- no lag, no stuck state.
      for (const sample of samples) expect(sample.lit).toBe(sample.high);
      expect(samples.some((s) => s.high)).toBe(true);
      expect(samples.some((s) => !s.high)).toBe(true);
    });
  });

  describe('fault latching', () => {
    it('keeps reporting an over-current that only occurs half of each blink cycle', () => {
      // The reason latching exists. Blink drives D13 high for 500 ms and low for 500 ms, so a
      // resistor-less LED exceeds the pin rating for exactly half the time. An instantaneous fault
      // list would flicker at the frame rate and imply the problem had gone away -- but exceeding
      // an absolute maximum even briefly is what kills the pin.
      const board = blinkBoard();
      board.circuit.add(new Led('D1', board.node('D13'), GROUND, 'red'));

      // Land in the low half of the cycle, where nothing is currently wrong.
      board.runFor(0.75);

      expect(board.activeFaults).toEqual([]);
      const latched = board.faults.find((f) => f.code === 'pin-over-current');
      expect(latched).toBeDefined();
      expect(latched!.subject).toBe('D13');
    });

    it('records when a fault first occurred, not when it was last seen', () => {
      const board = blinkBoard();
      board.circuit.add(new Led('D1', board.node('D13'), GROUND, 'red'));

      board.runFor(0.05);
      const first = board.faults.find((f) => f.code === 'pin-over-current')!.time;

      board.runFor(2);
      const afterMore = board.faults.find((f) => f.code === 'pin-over-current')!.time;

      expect(afterMore).toBe(first);
    });

    it('does not duplicate a fault that recurs every cycle', () => {
      const board = blinkBoard();
      board.circuit.add(new Led('D1', board.node('D13'), GROUND, 'red'));
      board.runFor(3);

      const overCurrent = board.faults.filter((f) => f.code === 'pin-over-current');
      expect(overCurrent).toHaveLength(1);
    });

    it('clears latched faults on reset', () => {
      const board = blinkBoard();
      board.circuit.add(new Led('D1', board.node('D13'), GROUND, 'red'));
      board.runFor(0.05);
      expect(board.faults.length).toBeGreaterThan(0);

      board.reset();
      expect(board.faults).toEqual([]);
    });

    it('reports no fault at all for a correctly resistored circuit', () => {
      const board = blinkBoard();
      const anode = board.circuit.addNode();
      board.circuit.add(new Resistor('R1', board.node('D13'), anode, 220));
      board.circuit.add(new Led('D1', anode, GROUND, 'red'));
      board.runFor(2.5);

      expect(board.faults).toEqual([]);
      expect(board.activeFaults).toEqual([]);
    });
  });

  describe('pin electrical model', () => {
    it('leaves an unconnected input floating near ground, not at a defined logic level', () => {
      const board = blinkBoard();
      board.runFor(0.001);
      // D2 is untouched by Blink: input, nothing attached. Only leakage holds it.
      expect(board.pin('D2').driveState).toBe('input');
      expect(Math.abs(board.voltage('D2'))).toBeLessThan(0.1);
    });

    it('pulls an input to the rail once the sketch enables the pull-up', () => {
      // Drive state comes from the MCU's port registers, never from the test: this is
      // `pinMode(2, INPUT_PULLUP)` in compiled firmware actually taking effect.
      const board = pullupBoard();
      board.runFor(0.01);

      expect(board.pin('D2').driveState).toBe('input-pullup');
      // 36k to VCC against 100M of leakage: essentially at the rail.
      expect(board.voltage('D2')).toBeGreaterThan(4.99);
    });

    it('applies VIL and VIH thresholds rather than a midpoint', () => {
      const pin = new Board({ progMem: loadHex(blinkHex) }).pin('D2');
      // VIL = 1.5 V, VIH = 3.0 V at a 5 V supply.
      expect(pin.readLevel(1.4, 5)).toBe('low');
      expect(pin.readLevel(3.1, 5)).toBe('high');
      expect(pin.readLevel(2.2, 5)).toBe('indeterminate');
    });

    it('holds the previous level through the undefined band, as a Schmitt input does', () => {
      const pin = new Board({ progMem: loadHex(blinkHex) }).pin('D2');
      // Drive it high, then present a voltage inside the band: it must not chatter.
      expect(pin.latchedLevel(4.5, 5)).toBe(true);
      expect(pin.latchedLevel(2.2, 5)).toBe(true);
      // Take it below VIL, then back into the band: now it holds low.
      expect(pin.latchedLevel(1.0, 5)).toBe(false);
      expect(pin.latchedLevel(2.2, 5)).toBe(false);
    });

    it('flags an input left in the undefined band', () => {
      // The classic beginner surprise: a 36k external resistor to ground against the 36k internal
      // pull-up sits at half rail -- squarely between VIL and VIH, where what the chip reads is
      // genuinely undefined. A logic-level simulator has to guess; this one says so.
      const board = pullupBoard();
      board.circuit.add(new Resistor('Rext', board.node('D2'), GROUND, 36_000));
      board.runFor(0.01);

      expect(board.voltage('D2')).toBeCloseTo(2.5, 1);
      const floating = board.faults.find((f) => f.code === 'floating-input');
      expect(floating).toBeDefined();
      expect(floating!.subject).toBe('D2');
      expect(floating!.severity).toBe('warning');
      expect(floating!.message).toMatch(/undefined/);
    });

    it('runs the whole button chain: pull-up, short to ground, sketch, LED', () => {
      // Source code to silicon to circuit and back. The sketch reads D2 and mirrors it to D13,
      // so D13 is a direct readout of what the input latch decided the voltage meant.
      const released = pullupBoard();
      released.runFor(0.01);
      expect(released.voltage('D2')).toBeGreaterThan(4.99);
      expect(released.mcu.pinState('D13')).toBe('low');

      const pressed = pullupBoard();
      // A button is a switch: closed contact resistance, not an ideal short.
      pressed.circuit.add(new Resistor('SW', pressed.node('D2'), GROUND, 0.05));
      pressed.runFor(0.01);
      expect(pressed.voltage('D2')).toBeLessThan(0.01);
      expect(pressed.mcu.pinState('D13')).toBe('high');
    });
  });

  describe('ADC', () => {
    it('reads a resistive divider as a real voltage', () => {
      // 10k/10k on A0 puts 2.5 V on the ADC input, which analogRead would return as ~512.
      const board = blinkBoard();
      const a0 = board.node('A0');
      board.circuit.add(new Resistor('Rtop', board.vcc, a0, 10_000));
      board.circuit.add(new Resistor('Rbot', a0, GROUND, 10_000));
      board.runFor(0.001);

      expect(board.voltage('A0')).toBeCloseTo(2.5, 2);
      // And the value handed to the ADC peripheral matches the solved node.
      expect(board.mcu.adc.channelValues[0]).toBeCloseTo(board.voltage('A0'), 9);
    });

    it('tracks a divider ratio across several values', () => {
      for (const [top, bottom, expected] of [
        [10_000, 10_000, 2.5],
        [10_000, 30_000, 3.75],
        [30_000, 10_000, 1.25],
      ] as const) {
        const board = blinkBoard();
        const a0 = board.node('A0');
        board.circuit.add(new Resistor('Rtop', board.vcc, a0, top));
        board.circuit.add(new Resistor('Rbot', a0, GROUND, bottom));
        board.circuit.solve();
        expect(board.circuit.voltage(a0)).toBeCloseTo(expected, 2);
      }
    });
  });

  describe('supply', () => {
    it('accounts for total current drawn from the rail', () => {
      const board = blinkBoard();
      const a = board.circuit.addNode();
      board.circuit.add(new Resistor('Rload', board.vcc, a, 100));
      board.circuit.add(new Resistor('Rgnd', a, GROUND, 100));
      board.circuit.solve();

      // 5 V across 200 ohm is 25 mA.
      expect(board.supplyCurrent).toBeCloseTo(0.025, 4);
    });

    it('flags drawing more than the VCC pin can carry', () => {
      const board = blinkBoard();
      // 20 ohm across the rail is 250 mA, past the 200 mA the supply pins are rated for.
      board.circuit.add(new Resistor('Rshort', board.vcc, GROUND, 20));
      board.runFor(0.001);

      const overCurrent = board.faults.find((f) => f.code === 'supply-over-current');
      expect(overCurrent).toBeDefined();
      expect(overCurrent!.message).toMatch(/mA/);
    });

    it('supports a 3.3 V board, scaling the logic thresholds with it', () => {
      const board = new Board({ progMem: loadHex(blinkHex), supplyVolts: 3.3 });
      board.runFor(0.05);

      expect(board.voltage('D13')).toBeCloseTo(3.3, 3);
      // VIH is 0.6 * VCC, so 2.2 V is a valid HIGH at 3.3 V but not at 5 V.
      expect(board.pin('D2').readLevel(2.2, 3.3)).toBe('high');
      expect(board.pin('D3').readLevel(2.2, 5)).toBe('indeterminate');
    });
  });
});
