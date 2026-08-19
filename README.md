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

**M0 complete** — the compile → emulate → observe spine works end to end.

- [x] **M0** Monorepo, compile service, AVR core binding, 1 Hz Blink verified
- [ ] **M1** MNA analog solver, pin electrical model, event-driven co-simulation
- [ ] **M2** Konva workspace, breadboard wiring, Monaco editor, serial monitor
- [ ] **M3** Oscilloscope, logic analyzer, register inspector, fault detection
- [ ] **M4** Part library breadth, `.rjp` project files, schematic view
- [ ] **M5** Tauri desktop shell, teaching hooks

## Layout

```
packages/
  sim-core/          simulation engine — no DOM, no framework, runs headless
    src/mcu/         avr8js binding, Uno pin map, Intel HEX loader
    src/analog/      MNA solver                          (M1)
    src/netlist/     nets and galvanic partitioning      (M1)
    src/sched/       event-driven co-simulation loop     (M1)
    src/faults/      absolute-max, brownout, floating    (M1)
  compile-service/   arduino-cli wrapper + diagnostics parser
```

`sim-core` never imports React and never touches `window`. That constraint is what keeps headless
testing cheap and makes the eventual Tauri port a packaging step rather than a rewrite.

## Getting started

Requires Node 20+ and Docker.

```bash
npm install
npm run image:build   # builds the pinned arduino-cli image (~2 min, once)
npm run verify        # typecheck + full test suite
```

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

## License

MIT
