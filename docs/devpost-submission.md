# Devpost submission — Build Beyond

Copy-paste answers for each field on the submission form.

---

## 1. Project name

```
Robo-Journey
```

## 2. Elevator pitch  (max 200 characters)

```
An Arduino simulator that fails the way the real bench fails — real compiled firmware on an emulated ATmega328P, wired into a genuine analog circuit solver that catches electrical faults.
```

(187 characters.)

---

## 3. About the project  (Markdown — paste the whole block below)

```markdown
## Inspiration

Every beginner blows up the same first circuit: an LED with no series resistor, a missing pull-up,
a 3.3 V sensor on a 5 V pin, a servo that browns out the regulator. Those are **electrical**
faults — and every simulator I could reach for runs that sketch happily and shows a glowing LED.

The existing tools each solve half the problem:

| Tool | Real firmware? | Real electricity? |
|---|---|---|
| Wokwi | yes — cycle-accurate AVR core | **no analog simulation** |
| Tinkercad Circuits | no — approximates the MCU | partial |
| Proteus VSM | yes | yes — commercial, and not in a browser |

So a student debugs a simulation that cannot reproduce the bug they actually have. Robo-Journey
exists to close that gap: simulate the firmware *and* the electricity, in a browser, for free.

## What it does

You write an Arduino sketch, wire a circuit on a breadboard, and press **Build & Run**.

- The sketch is compiled by **real `arduino-cli`** in a pinned, network-isolated Docker image, and
  loaded as **Intel HEX** — the same bytes a programmer streams to the bootloader, with every
  record checksum verified.
- Those bytes execute cycle-accurately on an emulated **ATmega328P** with genuine peripherals —
  GPIO, timers, USART, SPI, TWI, ADC, EEPROM, watchdog.
- Each pin is coupled to a **modified nodal analysis (MNA) circuit solver** with Newton-Raphson
  for nonlinear parts, so what leaves the pin is a voltage, not a bit.

That coupling is the whole point. A pin is not HIGH or LOW, it is a stamp: driven high means 25 Ω
to the rail, a pull-up means 36 kΩ, tri-state means 100 MΩ of leakage. `digitalWrite(13, HIGH)`
into an LED does not put 5.00 V on the pin — it puts about 4.65 V, because ~14 mA through the
output stage costs a third of a volt, exactly as a real Uno measures. Coming back in, the input
latch compares against V_IL (0.3·VCC) and V_IH (0.6·VCC); between them the reading is genuinely
undefined, so the simulator holds the previous level like a real Schmitt trigger and raises a
**floating-input fault** instead of quietly guessing.

Main features:

- **Hardware-accurate co-simulation** — event-driven, so the analog solver re-solves the instant a
  pin changes rather than on a fixed clock.
- **Fault detection** — over-current, floating inputs, absolute-maximum-rating violations, caught
  as electrical events rather than as a mysteriously wrong output.
- **Instruments, not just output** — oscilloscope and logic analyser on uPlot, a named register
  inspector, a live disassembler, and breakpoints.
- **A serial decoder that reads the wire.** avr8js models the USART behaviourally — it reports the
  byte written to UDR and never touches D1, which makes the most common serial fault of all, a
  mismatched baud rate, impossible to observe. Here the TX waveform is synthesised from UBRR and
  the U2X multiplier read straight from the registers, so `Serial.begin(9600)` really does put
  104 µs bits on the wire, and the decoder reads bytes back off the *voltage*.
- **Components from datasheets.** A component is data, not code: a manifest describes its package,
  pins, per-pin electrical model, behaviour archetype, absolute maximum ratings and provenance.
  Paste a datasheet and Gemini returns a manifest, which is parsed by zod, then checked against
  physics (V_IL above V_IH, a pin sourcing 40 amps, a reserved I²C address, an active part with no
  ground) before it is allowed near a circuit.
- **Never gates on sign-in.** Local autosave works signed out; an account only adds sync across
  machines. A seat queue lets ten people simulate at once and admits everyone else automatically.
- **An assistant with a safety rail** — Ask answers questions about *your* circuit; Agent returns
  structured actions that are checked and shown as a plan before a single step is applied.

## How I built it

A TypeScript monorepo, deliberately layered so the engine never depends on the app:

```
packages/
  sim-core/          the engine — no DOM, no framework, runs headless
    src/mcu/         avr8js binding, Uno pin map, Intel HEX loader
    src/analog/      MNA solver, LU decomposition, Newton-Raphson, device models
    src/sched/       event-driven co-simulation loop
    src/faults/      over-current, floating input
    src/netlist/     union-find nets and breadboard topology
  parts/             component SDK, part library, project model
  compile-service/   Fastify server + arduino-cli wrapper + diagnostics parser
  datasheet/         datasheet → validated component manifest
  accounts/          Postgres accounts, sessions, seat queue, credits
  assistant/         Gemini calls, server-side only
apps/
  studio/            dockview shell, Konva canvas, Monaco editor, xterm serial
```

`sim-core` never imports React and never touches `window`. That one constraint keeps headless
testing cheap and makes a future desktop port a packaging step rather than a rewrite.

Deployment is a single `docker compose up`, or one bootstrap command on a fresh server that brings
up Caddy with an auto-renewing certificate — and refuses to take port 443 from a site already
using it.

## Challenges I ran into

- **Timing fidelity is fragile in both directions.** `delay(500)` measures 500.008–500.012 ms in
  simulation, because the Arduino core spins until the timer0 millis() tick advances and then costs
  a few more cycles in the loop. There is a test asserting that overshoot is *non-zero*: if it ever
  became exactly 500.000000 ms, we would have lost fidelity, not gained accuracy.
- **Every digital edge is a discontinuity.** Trapezoidal integration carries the previous step's
  current into the next one, which is meaningless across a jump and shows up as ringing on exactly
  the edges this simulator exists to get right. The fix was declaring discontinuities and forcing
  one damped Backward Euler step before returning to second-order accuracy.
- **SPICE's default tolerance is not good enough here.** At `RELTOL = 1e-3` a 5 V loop closes KVL
  only to ~6 mV — wider than an ADC least significant bit, so a simulated multimeter would disagree
  with a simulated `analogRead` on the same node. At `1e-9` the residual is ~1e-11 V for three
  extra Newton iterations.
- **Trusting an LLM with physics.** Datasheets quote milliamps, microseconds and kilohms; the
  schema wants amps, seconds and ohms — and a 20 mA pin recorded as 20 A passes every structural
  check while browning out a board the real part would not. So extraction is never trusted: every
  generated manifest carries an `unresolved` list naming each value the datasheet did not state and
  the assumption made instead, and stays unverified until a human says otherwise. A populated
  `unresolved` list is a *successful* extraction; a silently invented number is a failed one nobody
  will catch.
- **Concurrency in the seat queue.** Two service instances each seeing nine seats taken would each
  admit someone into the tenth. Every reconcile pass now runs in a transaction holding a Postgres
  advisory lock, so "ten" means ten no matter how many processes are serving.

## Accomplishments I'm proud of

- **An HC-SR04 built entirely from its datasheet** measures 580.1 µs at 10 cm, 2320.1 µs at 40 cm
  and 8700.1 µs at 150 cm — exact against the module's own 58 µs/cm — with real compiled firmware
  calling `pulseIn` and printing the right distance.
- **`pinMode(OUTPUT)` produces an observable glitch.** Setting DDRB while PORTB is still 0 drives
  the pin LOW for ~50 cycles before `digitalWrite` raises it. That is real — a latch or MOSFET gate
  would see it — and the simulator does not smooth it away.
- **Performance.** A ~55-node circuit with 14 LEDs and 6 dividers simulates at **2.05× real time**
  on an M-series Mac, so the TypeScript solver has roughly 2× headroom; the Rust/WASM port stays in
  reserve.
- **The verification gate.** `npm run verify` typechecks every package and runs the suite —
  including a full-spine test that compiles Blink through Docker and asserts the emulated D13
  toggles at 1 Hz, plus the account and queue suites against a real Postgres and Redis brought up
  for the run and taken away afterwards.

## What I learned

Fidelity is a design constraint, not a feature you add later. Almost every hard bug came from a
place where a shortcut had been taken — a behavioural USART, a logic-level pin, a loosened solver
tolerance — and each one silently removed exactly the class of failure a student most needs to see.
Modelling a pin as an impedance rather than a boolean changed more about what this tool can teach
than any amount of UI work would have.

I also learned to make the security boundaries structural rather than remembered: the Gemini key
lives in a server-side package the browser bundle cannot import, session tokens are stored only as
SHA-256 hashes, and a wrong password and a missing account return the same message and pay the same
hashing cost — so neither the response nor its timing reveals which addresses are registered.

## Technology stack

**Simulation:** TypeScript, `avr8js` (cycle-accurate AVR core, MIT), a hand-written MNA solver with
LU decomposition and Newton-Raphson, Intel HEX loading.
**Frontend:** React 19, Vite, Zustand, Konva (breadboard canvas), Monaco (editor), dockview
(panels), uPlot (scope and logic analyser), xterm.js (serial), Comlink (worker boundary), MUI.
**Backend:** Node 20, Fastify, Docker (`arduino-cli`, `--network none`), PostgreSQL, Redis,
Caddy + Let's Encrypt.
**AI:** Google Gemini for datasheet extraction and the in-app assistant, with zod schema validation
and a physics validator in front of anything it returns.
**Testing:** Vitest — unit, integration, full-spine Docker compile tests, and performance
benchmarks that assert the requirement rather than the measured figure, so they survive a slow CI
box.

## Intended audience

Students learning embedded systems, self-taught makers without a parts drawer, and instructors who
want a class of thirty to hit real electrical failures — a browned-out regulator, a floating input,
an LED drawing 60 mA — without thirty destroyed Arduinos. It is equally useful to anyone
prototyping a circuit before ordering parts.

## What's next

A Tauri desktop shell (the engine is already framework-free, so it is a packaging step), teaching
hooks — guided lessons that assert on the *waveform*, not on the code — and a Rust/WASM solver port
when circuits get big enough to need it.
```

---

## 4. Built with  (tags — paste one at a time)

```
typescript, react, vite, zustand, konva, monaco-editor, dockview, uplot, xterm.js, comlink, material-ui, node.js, fastify, postgresql, redis, docker, caddy, avr8js, arduino-cli, arduino, atmega328p, google-gemini, zod, vitest, circuit-simulation
```

## 5. "Try it out" links

```
https://github.com/clickTwice26/robo-journey
```

Add a second link with **ADD ANOTHER LINK** if you have the app deployed on a domain —
`deploy/bootstrap.sh` will stand it up with a certificate. A live URL judges can click is worth
real points under "Clarity of Submission".

## 6. Image gallery

The screenshots are already in `docs/screenshots/`. Upload in this order — the first becomes the
project thumbnail, so lead with the one that shows the simulator actually running:

| # | File | Suggested caption |
|---|---|---|
| 1 | `05-blink-running.png` | Real compiled firmware running on the emulated ATmega328P, driving a real analog circuit. |
| 2 | `06-scope.png` | Oscilloscope and logic analyser — the serial decoder reads bytes off the voltage on D1. |
| 3 | `07-mcu.png` | Named register inspector: the actual MCU state behind the waveform. |
| 4 | `08-disassembly.png` | Live disassembly and breakpoints on the executing machine code. |
| 5 | `02-landing-catches.png` | The electrical faults a logic-level simulator cannot see. |
| 6 | `04-empty-state.png` | The workspace: breadboard canvas, editor, serial, all in one shell. |
| 7 | `01-landing.png` | Landing page. |
| 8 | `03-sign-in.png` | Accounts are optional — everything works signed out. |

Also worth adding, if you can grab them: the datasheet-extraction dialog showing the `unresolved`
list, and a fault firing on an LED with no series resistor. Those two images *are* the pitch.

## 7. Video demo link

Not recorded yet. A 2–3 minute screen capture (YouTube, unlisted is fine) is the highest-value
thing left — "Clarity of Submission" is 10% and a video carries the other 90% too. Suggested cut:

1. **0:00–0:20** — the problem: an LED with no resistor, and what other simulators show you.
2. **0:20–1:00** — Blink: write, Build & Run, LED blinks, scope shows the edge.
3. **1:00–1:45** — the fault: same circuit without the resistor, over-current fires; then the
   baud-rate mismatch decoded off the wire.
4. **1:45–2:30** — paste an HC-SR04 datasheet, watch it become a working part, wire it up, and
   print the right distance from `pulseIn`.
5. **2:30–3:00** — architecture in one sentence: real `arduino-cli`, real AVR machine code, real
   MNA solver.
