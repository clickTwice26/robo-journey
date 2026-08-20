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

**M4 complete** — the platform holds components nobody compiled in. Paste or upload a datasheet and
it becomes a working part: pins, electrical models, timing and limits, validated against physics
before it is allowed near a circuit.

**M3 complete** — the app now measures as well as simulates. Scope and logic analyser on uPlot,
named register inspector, and a serial decoder that reads bytes back off the voltage on D1 rather
than from the peripheral that sent them.

- [x] **M0** Monorepo, compile service, AVR core binding, 1 Hz Blink verified
- [x] **M1** MNA analog solver, pin electrical model, event-driven co-simulation
- [x] **M2** Konva workspace, breadboard wiring, Monaco editor, serial monitor
- [x] **M3** Oscilloscope, logic analyser with serial decode, register inspector, disassembler, breakpoints
- [x] **M4** Data-driven component manifests, and datasheet extraction with Gemini
- [x] Transistors, MOSFETs, op-amps, potentiometers, I²C, accounts and persistence
- [ ] **M5** Tauri desktop shell, teaching hooks
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
cp .env.example .env   # set POSTGRES_PASSWORD
docker compose up --build
```

Then open http://localhost:28610, create an account, pick **Examples → Blink an LED**, and press
**Build & Run**. The service serves the studio and the API from one origin, so there is no proxy to
configure. See [DEPLOYMENT.md](DEPLOYMENT.md) for what runs where and why.

For day-to-day work, run only the backing services and keep Vite's feedback loop:

```bash
npm install
docker compose -f docker-compose.dev.yml up -d   # postgres + redis
npm run service                                  # in one terminal
npm run dev                                      # in another
```

That puts the app on http://localhost:28611. The ports sit well away from the crowded defaults so
this can run beside other projects; the dev server uses `strictPort`, so a collision fails loudly
rather than silently moving somewhere the API proxy is not looking.

```bash
npm run verify        # typecheck, 574 tests, benchmarks
```

`npm run verify` is the gate. It typechecks every package and the app, then runs the suite —
including a full-spine test that compiles Blink through Docker and asserts the emulated D13 toggles
at 1 Hz, and the account and queue suites against a real Postgres and Redis brought up for the run
and taken away afterwards. Without Docker those suites skip with a notice rather than failing.

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

**The USART drives its pin.** avr8js models the USART behaviourally — it reports the byte written
to UDR and never touches D1. Fine for a serial monitor, useless for a logic analyser, and it makes
the most common serial fault of all, a baud rate that does not match, impossible to observe. The TX
waveform is synthesised here from UBRR and the U2X multiplier read straight from the registers, so
`Serial.begin(9600)` really does put 104 µs bits on the wire, and `pinState` honours the datasheet's
pin-override table once TXEN is set.

**Capture is event-driven, like the solver.** Samples are taken on every analog solve rather than
on a sample clock, and the solver already re-solves the instant a pin changes — so an edge lands in
the buffer at its exact time. That is what makes decoding a real UART frame possible at all.

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

## Components from datasheets

A component is data, not code. `packages/parts/src/manifest.ts` describes one: its package and
pins, an electrical model per pin, one of eight behaviour archetypes, its absolute maximum ratings,
and its provenance. Anything expressible there simulates, and nothing else can be expressed — a
manifest cannot describe physics the solver has no way to compute.

That makes extraction possible. Gemini reads a datasheet and returns a manifest, which is then:

1. parsed by zod, so it is structurally valid;
2. checked against physics by `validateManifest`, which catches what a schema cannot — VIL above
   VIH, a pin sourcing 40 amps, an SDA reference to a pin that does not exist, a reserved I²C
   address, an active part with no ground;
3. handed back to the model with the specific failures if either check fails, because naming the
   error fixes it far more reliably than asking for another attempt.

**Extraction is never trusted.** Every generated manifest carries an `unresolved` list naming each
value the datasheet did not state and the assumption made instead, and it is marked unverified
until a human says otherwise. A populated `unresolved` list is a successful extraction; a silently
invented number is a failed one nobody will catch. The prompt says so explicitly, and the UI shows
the list before you can add the part.

The unit table in the prompt exists for one reason: datasheets quote milliamps, microseconds and
kilohms, the schema wants amps, seconds and ohms, and a 20 mA pin recorded as 20 A passes every
structural check while making the simulated part brown out a board the real one would not.

Verified end to end: an HC-SR04 datasheet becomes a manifest whose echo pulse measures 580.1 µs at
10 cm, 2320.1 µs at 40 cm and 8700.1 µs at 150 cm — exact against the module's own 58 µs/cm — with
real compiled firmware calling `pulseIn` and printing the right distance.

**The API key stays server-side.** The browser posts the datasheet to the compile service, which
holds the key. A key in a frontend bundle is a published key.

```bash
cp .env.example .env    # then add your GEMINI_API_KEY
npm run test:live       # runs the extraction tests; skips itself without a key
```

## Persistence

Two layers, and the first matters most because it needs no account.

**Local autosave.** The open circuit is written to `localStorage`, debounced, flushed when the tab
hides, and restored at store creation rather than in an effect — so the first render already has
your work, with no flash of an empty canvas and no window in which an autosave could fire against
the default document and overwrite the real one. A stored project that no longer validates is
discarded rather than repaired: silently loading half a document is worse than starting fresh,
because you would not know which half.

**Accounts**, for syncing across machines, in Postgres. Passwords are hashed with scrypt at
N=2^15 (~55 ms), salted per user, with the cost parameters stored alongside so they can be raised
later without forcing a password reset. Session tokens are 32 random bytes stored only as a
SHA-256 hash, so a leaked database does not hand over live sessions. Cookies are `httpOnly` and
`SameSite=Strict`.

**A queue**, because an account alone does not make the simulator usable — ten people can use it at
once, for an hour each, and everyone else waits in line and is let in automatically. The wait
between turns is worked out from how many people are queuing rather than fixed: about a minute when
the place is quiet, longer when it is busy, and shortened again if the queue clears. That limit is
the reason the store is Postgres rather than a file: two service instances each seeing nine seats
taken would each admit someone into the tenth. Every reconcile pass runs in a transaction holding
an advisory lock, so "ten" means ten no matter how many processes are serving.

**Redis**, for the two things better off ephemeral: rate-limit counters, which were per-process and
therefore not a limit at all once there was more than one process, and the compile cache, which is
content-addressed and worth sharing across instances.

A wrong password and a missing account return the same message, and a missing account still pays
the cost of a hash — so neither the response nor its timing reveals which addresses are registered.
Login is rate-limited per address and per account, because those are different attacks.

The app never gates on sign-in. Everything works signed out; an account only adds sync.

## Performance

A ~55-node circuit with 14 LEDs and 6 dividers simulates at **2.05x real time** on an M-series Mac,
so the TypeScript solver has roughly 2x headroom against the requirement. The Rust/WASM port stays
in reserve; `packages/sim-core/test/performance.test.ts` is the regression guard, and it asserts
the requirement (1.0x) rather than the measured figure so it survives a slow CI box.

## License

MIT
