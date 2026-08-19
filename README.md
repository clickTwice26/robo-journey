# robo-journey

A hardware-accurate Arduino circuit simulator. Sketches are compiled by real `arduino-cli` and
executed as actual machine code on an emulated ATmega328P, coupled to a genuine analog circuit
solver — so the simulation fails the way the bench fails.

## Why

Existing simulators each solve half the problem:

| Tool | Real firmware? | Real electricity? |
|---|---|---|
| Wokwi | yes — cycle-accurate AVR core | **no analog simulation** |
| Tinkercad Circuits | no — approximates the MCU | partial |
| Proteus VSM | yes | yes — commercial |

A missing pull-up, an LED with no series resistor, a 3.3 V part on a 5 V pin, a servo browning out
the regulator: these are **electrical** faults. A logic-level simulator runs that sketch happily and
shows a glowing LED. The real board gives you a dead pin.

## Status

**M2 complete** — there is an app. Load an example, press Run, and watch a real LED light from real
firmware; omit the resistor and the Problems panel tells you the pin is passing 93.3 mA.

- [x] **M0** Monorepo, compile service, AVR core binding, 1 Hz Blink verified
- [x] **M1** MNA analog solver, pin electrical model, event-driven co-simulation
- [x] **M2** Konva workspace, breadboard wiring, Monaco editor, serial monitor
- [ ] **M3** Oscilloscope, logic analyzer, register inspector, fault detection
- [ ] **M4** Part library breadth, `.rjp` project files, schematic view
- [ ] **M5** Tauri desktop shell, teaching hooks

## Layout

```
packages/
  sim-core/          simulation engine — no DOM, no framework, runs headless
    src/mcu/         avr8js binding, Uno pin map, Intel HEX loader
    src/analog/      MNA solver, LU, Newton-Raphson, device models
    src/sched/       Board -- event-driven co-simulation loop
    src/faults/      over-current, floating input
    src/netlist/     union-find nets and breadboard topology
  parts/             component SDK, part library, project model, examples
  compile-service/   arduino-cli wrapper + diagnostics parser
apps/
  studio/            the app: dockview shell, Konva canvas, Monaco, xterm
```

Currently 162 tests plus 3 benchmarks, all green.

`sim-core` never imports React and never touches `window`. That constraint is what keeps headless
testing cheap and makes the eventual Tauri port a packaging step rather than a rewrite.

## Getting started

Requires Node 20+ and Docker.

```bash
npm install
npm run image:build   # builds the pinned arduino-cli image (~2 min, once)
npm run verify        # typecheck, test suite, benchmarks
```

To run the app, start the compile service and the dev server:

```bash
npm run start -w @robo-journey/compile-service
```

```bash
npm run dev -w @robo-journey/studio
```

Then open http://localhost:5173, pick **Examples → Blink an LED**, and press **Build & Run**.

`npm run verify` is the gate: it typechecks every package and runs 32 tests, including a full-spine
integration test that compiles Blink through Docker and asserts the emulated D13 toggles at 1 Hz.

Tests that need Docker skip themselves when the image is absent, so a checkout without Docker still
runs green against the committed firmware fixture.

## Design notes

**The CPU core is [`avr8js`](https://github.com/wokwi/avr8js) (MIT).** It executes real compiled AVR
machine code cycle-accurately with genuine peripherals — GPIO, timers, USART, SPI, TWI, ADC, EEPROM,
watchdog. Its documented limit is that it implements *only* the CPU core and leaves external
hardware to the embedder. That gap is this project.

**Firmware is loaded as Intel HEX**, the same bytes a programmer streams to the bootloader, with
every record checksum verified. A corrupt image that still parses would execute as garbage and
present as a baffling simulation bug.

**Compilation is hermetic.** The pinned Docker image runs with `--network none` and the AVR core
baked in, so a given sketch yields identical bytes forever. The committed test fixture is
regenerable with `npm run fixtures:build` and hashes identically each time.

**Timing fidelity is the point.** `delay(500)` measures 500.008–500.012 ms in simulation, because
the Arduino core spins until the timer0 millis() tick advances and then costs a few more cycles in
the loop. There is a test asserting that overshoot is *non-zero*: if it ever became exactly
500.000000 ms we would have lost fidelity, not gained accuracy.

**`pinMode(OUTPUT)` produces an observable glitch.** Setting DDRB while PORTB is still 0 drives the
pin LOW for ~50 cycles before `digitalWrite` raises it. That is real, a latch or MOSFET gate would
see it, and the simulator does not smooth it away.

**A pin is not HIGH or LOW, it is a stamp.** Driven high means 25 ohm to the rail; a pull-up means
36 kOhm; tri-state means 100 MOhm of leakage. So `digitalWrite(13, HIGH)` into an LED does not put
5.00 V on the pin -- it puts about 4.65 V, because ~14 mA through the output stage costs a third of
a volt, exactly as a real Uno measures.

**What comes back is a voltage, not a bit.** The input latch compares against VIL (0.3 VCC) and VIH
(0.6 VCC). Between them the reading is genuinely undefined, so the simulator holds the previous
level -- as the real Schmitt trigger does -- and separately reports a floating-input fault instead
of quietly guessing.

**Solver tolerance is tighter than SPICE's.** SPICE defaults to `RELTOL = 1e-3`, tuned for netlists
with millions of nodes. At that setting a 5 V loop closes KVL only to about 6 mV -- wider than an
ADC least significant bit, so a simulated multimeter would disagree with a simulated `analogRead`
on the same node. At `1e-9` the residual is ~1e-11 V for three extra Newton iterations.

**Every digital edge is a discontinuity.** Trapezoidal integration carries the previous step's
current into the next one, which is meaningless across a jump and shows up as ringing on exactly
the edges this simulator exists to get right. A declared discontinuity forces one damped Backward
Euler step before returning to second-order accuracy.

## Performance

A ~55-node circuit with 14 LEDs and 6 dividers simulates at **2.05x real time** on an M-series Mac,
so the TypeScript solver has roughly 2x headroom against the requirement. The Rust/WASM port stays
in reserve; `packages/sim-core/test/performance.test.ts` is the regression guard, and it asserts
the requirement (1.0x) rather than the measured figure so it survives a slow CI box.

## License

MIT
