/**
 * The extraction prompt.
 *
 * This is the most consequential file in the package. A simulator's whole value is that its numbers
 * are real, so the prompt's job is not to get an answer but to get a *traceable* one -- and to make
 * the model say plainly when the datasheet did not tell it something.
 *
 * Three failure modes drove how it is written:
 *
 * 1. **Unit slips.** Datasheets quote milliamps, microseconds and kilohms; the schema wants amps,
 *    seconds and ohms. A 20 mA pin recorded as 20 A passes every structural check and makes the
 *    simulated part brown out a board the real one would not. Hence the explicit unit table and
 *    the worked conversions.
 *
 * 2. **Confident invention.** Asked for an output impedance a datasheet does not give, a model
 *    will supply a plausible one. That is worse than a gap, because a gap can be checked. Hence
 *    `unresolved`, and the instruction that filling it in is the successful outcome, not a failure.
 *
 * 3. **Archetype mismatch.** Forcing a part into the wrong behaviour kind produces something that
 *    simulates smoothly and wrongly. Hence the decision list, written as questions about the part
 *    rather than as descriptions of the kinds.
 */

/** Bumped whenever the prompt changes materially, and recorded in provenance. */
export const PROMPT_VERSION = 4;

export const SYSTEM_INSTRUCTION = `
You extract electronic component models from datasheets for a circuit simulator that runs real
firmware against a real analog solver. Accuracy of the numbers is the entire point: a simulation
built on a guessed value is worse than no simulation, because the user will believe it.

Return ONLY a single JSON object. No markdown fence, no commentary.
`.trim();

/**
 * The schema description handed to the model.
 *
 * Written out rather than generated from zod because the model needs the *meaning* of each field
 * -- which datasheet table it comes from, what unit it is in -- and a generated schema carries only
 * the type.
 */
export const SCHEMA_GUIDE = `
{
  "schemaVersion": 1,
  "id": "lower-case-hyphenated-id",           // e.g. "hc-sr04", "tmp36", "ssd1306"
  "name": "Human readable name",
  "manufacturer": "",
  "partNumber": "",
  "category": "sensor" | "actuator" | "display" | "passive" | "power" | "logic" | "module",
  "description": "One or two sentences on what it does and how it is driven.",

  "package": {
    "type": "DIP-8" | "TO-92" | "module" | ...,
    "widthMm": number,        // from the mechanical drawing
    "heightMm": number,
    "pinPitchMm": 2.54,       // 2.54 for anything breadboard compatible
    "bodyColor": "#rrggbb"
  },

  "pins": [                    // EVERY pin, in datasheet order, including NC pins
    {
      "name": "VCC",           // exact datasheet name
      "number": 1,
      "x": 0, "y": 0,          // millimetres from the part origin, spaced by pinPitchMm
      "description": "short description from the pin table",
      "model": <PIN MODEL>
    }
  ],

  "state": [                   // physical quantities the WORLD supplies to this part
    { "name": "distanceCm", "label": "Distance", "unit": "cm",
      "min": 2, "max": 400, "default": 40, "step": 1 }
  ],

  "behavior": <BEHAVIOR>,
  "limits": {
    "vccMinVolts": number, "vccMaxVolts": number,
    "pinMaxAmps": number, "totalMaxAmps": number,
    "operatingTempMinC": number, "operatingTempMaxC": number
  },
  "provenance": {
    "source": "datasheet-ai",
    "datasheetName": "title from the document",
    "confidence": 0.0 to 1.0,
    "unresolved": ["every value the datasheet did not state, and what you assumed instead"],
    "verified": false
  }
}

PIN MODEL is exactly one of:
  { "kind": "power", "vNom": V, "vMin": V, "vMax": V, "iQuiescent": A }
  { "kind": "ground" }
  { "kind": "digital-in", "vih": V, "vil": V, "impedanceOhms": R, "pull": "none"|"up"|"down", "pullOhms": R }
  { "kind": "digital-out", "impedanceOhms": R, "sourceMaxA": A, "sinkMaxA": A, "openDrain": bool }
  { "kind": "analog-in", "impedanceOhms": R }
  { "kind": "analog-out", "impedanceOhms": R }
  { "kind": "passive", "toPin": "NAME", "ohms": R }          // a built-in series or pull resistor
  { "kind": "led", "cathodePin": "NAME", "color": "red", "vf": V, "ifNominalA": A, "ifMaxA": A }
  { "kind": "nc" }

BEHAVIOR is exactly one of:
  { "kind": "passive" }

  { "kind": "analog-sensor", "outputPin": "NAME", "state": "stateName",
    "voltsPerUnit": number, "offsetVolts": number, "clampToSupply": true }
      // Vout = voltsPerUnit * quantity + offsetVolts. TMP36: 0.01 V/C with a 0.5 V offset.

  { "kind": "variable-resistor", "pinA": "NAME", "pinB": "NAME", "state": "stateName",
    "ohmsAtMin": R, "ohmsAtMax": R }
      // LDRs, thermistors, potentiometers, flex sensors. Interpolated logarithmically.

  { "kind": "i2c-peripheral", "address": 0x00-0x77, "sdaPin": "NAME", "sclPin": "NAME",
    "registers": [ { "address": n, "name": "...", "reset": n, "access": "r"|"w"|"rw",
                     "fromState": "stateName", "scale": n, "offset": n, "bytes": 1 } ] }

  { "kind": "spi-peripheral", "mosiPin": "...", "misoPin": "...", "sckPin": "...", "csPin": "...",
    "mode": 0-3, "csActiveLow": bool, "bitOrder": "msbFirst"|"lsbFirst", "maxClockHz": Hz,
    "addressing": "register"|"stream", "readBitPosition": 0-7, "readBitValue": 0|1,
    "autoIncrement": bool, "registers": [ ... ] }
      // mode comes from CPOL and CPHA in the timing section: CPOL 0 / CPHA 0 is mode 0,
      // 0/1 is mode 1, 1/0 is mode 2, 1/1 is mode 3. Getting this wrong produces a part that
      // simulates as returning nothing, so read it from the timing diagram rather than guessing.
      // maxClockHz is the SCK frequency limit from the AC characteristics -- 10 MHz, not 10.
      // addressing: "register" for the usual command byte carrying a read/write flag plus a
      // register address (nearly every sensor). "stream" for parts with no register map at all,
      // such as shift registers and graphic displays.
      // readBitPosition / readBitValue describe that command byte: which bit is the flag and
      // which value of it means read. Most parts use bit 7 with 1 meaning read; some invert it.
      // Take this from the datasheet's serial-interface section, not from a similar part.

  { "kind": "regulator",
    "inputPin": "NAME", "outputPin": "NAME", "groundPin": "NAME",
    "outputVolts": V, "dropoutVolts": V, "quiescentAmps": A, "maxOutputAmps": A,
    "outputImpedanceOhms": R, "thermalOhmsPerWatt": n, "thermalShutdownC": n,
    "thermalMassJPerK": n }
      // 7805, LM317, AMS1117, LM1117, MCP1700 and every other three-terminal linear regulator.
      // dropoutVolts is the headroom the part needs ABOVE its output, not its maximum input.
      // A 78xx needs about 2 V, an AMS1117 about 1.1 V, a modern LDO 0.2 V or less. This single
      // number decides whether a battery-powered design works at all, so take it from the dropout
      // voltage specification and not from the input voltage range.
      // quiescentAmps is the ground-pin or quiescent current: 5 mA is 0.005, not 5.
      // thermalOhmsPerWatt is the junction-to-AMBIENT figure (RthJA), not junction-to-case.
      // Roughly 65 for a bare TO-220, 110 for SOT-223, 200+ for SOT-23. If the datasheet gives
      // only junction-to-case, use the free-air figure for the package and say so in unresolved.
      // outputImpedanceOhms comes from the load regulation spec; 0.02 is a fair default.
      // thermalMassJPerK is on no datasheet -- 0.9 for TO-220, 0.15 for SOT-223, 0.02 for SOT-23.
      // It only sets how long overheating takes, not whether it happens, so assume and move on.

  { "kind": "pulse-echo", "triggerPin": "NAME", "echoPin": "NAME", "state": "stateName",
    "minTriggerSeconds": s, "responseDelaySeconds": s, "secondsPerUnit": s, "timeoutSeconds": s }
      // Trigger-and-echo rangefinders. HC-SR04: 10e-6 trigger, 58e-6 s per cm.

  { "kind": "pwm-actuator", "signalPin": "NAME",
    "minPulseSeconds": s, "maxPulseSeconds": s, "minPosition": n, "maxPosition": n,
    "slewPerSecond": n, "movingCurrentA": A, "holdCurrentA": A }
      // Hobby servos and ESCs.

  { "kind": "threshold-switch", "outputPin": "NAME", "state": "stateName",
    "threshold": n, "activeLow": bool, "hysteresis": n }
      // PIR sensors, comparator modules, reed switches, limit switches.

  { "kind": "transistor", "polarity": "npn"|"pnp",
    "collectorPin": "NAME", "basePin": "NAME", "emitterPin": "NAME",
    "forwardBeta": n, "reverseBeta": n, "saturationCurrent": n }
      // Bipolar junction transistors: BC547, 2N3904, 2N2222, BC557 and the rest.
      // forwardBeta is the datasheet's hFE -- use the TYPICAL figure, not the minimum.
      // saturationCurrent is the transport Is, around 1e-14 for a small-signal device; the
      // datasheet will not give it, so assume 1e-14 and say so in unresolved.
      // reverseBeta is rarely quoted; 4 is a reasonable assumption.

  { "kind": "mosfet", "channel": "n"|"p",
    "drainPin": "NAME", "gatePin": "NAME", "sourcePin": "NAME",
    "thresholdVolts": V, "k": n, "rdsOnOhms": R, "lambda": n }
      // IRLZ44N, IRF540, 2N7000, AO3400 and the rest.
      // thresholdVolts is VGS(th) -- use the TYPICAL figure, not the maximum.
      // rdsOnOhms is RDS(on) at the stated gate voltage. 22 mOhm is 0.022, not 22.
      // k is not on any datasheet. Derive it from a quoted operating point:
      //   k = 2 * Id / (Vgs - Vth)^2   using an Id at a stated Vgs from the characteristics.
      //   Say in unresolved which point you used.

  { "kind": "op-amp",
    "nonInvertingPin": "NAME", "invertingPin": "NAME", "outputPin": "NAME",
    "positiveRailPin": "NAME", "negativeRailPin": "NAME",
    "openLoopGain": n, "outputImpedanceOhms": R, "inputImpedanceOhms": R,
    "headroomHighVolts": V, "headroomLowVolts": V }
      // LM358, LM324, TL072, MCP6002.
      // openLoopGain: convert dB to a ratio -- 100 dB is 100000, not 100.
      // headroom is the difference between each supply rail and the output swing the datasheet
      // guarantees. For an LM358 that is around 1.5 V from the positive rail; for a rail-to-rail
      // part it is tens of millivolts. This is the number that decides whether a single-supply
      // circuit works, so take it from the output voltage swing specification.

  { "kind": "potentiometer",
    "terminalAPin": "NAME", "wiperPin": "NAME", "terminalBPin": "NAME",
    "totalOhms": R, "taper": "linear"|"log", "state": "stateName" }
      // Declare a state variable from 0 to 1 for the knob position.
`.trim();

export const RULES = `
UNITS. The schema is strictly SI base units. Datasheets are not. Convert every value:
  20 mA  -> 0.02          amps, never 20
  1.5 uA -> 0.0000015     amps
  10 us  -> 0.00001       seconds, never 10
  58 us  -> 0.000058      seconds
  4.7 k  -> 4700          ohms
  100 nF -> 0.0000001     farads
  3.3 V  -> 3.3           volts
Millimetres for all geometry. A milliamp figure written as amps is the single most common and most
damaging extraction error, because it passes every structural check.

CHOOSING A BEHAVIOUR. Ask about the part, not about the list:
  Does the host pulse one pin and time a pulse coming back?        -> pulse-echo
  Does the host send a ~20 ms repeating pulse whose width commands it? -> pwm-actuator
  Does its output voltage vary continuously with something physical?  -> analog-sensor
  Does its resistance vary with something physical?                   -> variable-resistor
  Does it sit on SDA/SCL and answer at an address?                    -> i2c-peripheral
  Does it have MOSI/MISO/SCK/CS?                                      -> spi-peripheral
  Does one pin just go high or low when a quantity crosses a point?   -> threshold-switch
  Is it a bipolar transistor with a collector, base and emitter?      -> transistor
  Does it have a gate, drain and source?                              -> mosfet
  Does it have two inputs, an output, and enormous gain?              -> op-amp
  Is it a three-terminal pot with a wiper?                            -> potentiometer
  Does it take an unregulated input and hold an output voltage fixed?  -> regulator
  Is it only resistors, capacitors, diodes or LEDs?                   -> passive
If the part genuinely fits none of these, pick the closest, set confidence below 0.5, and say so in
unresolved.

REGULATORS. Never model one as a fixed voltage source or as "passive". The whole reason to
simulate a regulator is that it stops working in two specific ways -- it runs out of input voltage,
and it overheats -- and both of those are decided by numbers on its datasheet. A regulator
extracted without a dropout voltage and a thermal resistance is worse than no regulator at all,
because it makes an under-powered or over-loaded design look correct.

DISCRETE SEMICONDUCTORS. A transistor has no state variable and no protocol -- it amplifies. Use
the transistor archetype rather than forcing it into "passive": a passive approximation cannot
switch, cannot saturate, and produces a part that looks right on the canvas and does nothing in the
circuit.

STATE VARIABLES. Any part that senses something needs the quantity it senses declared in "state",
or it will sense nothing forever. A rangefinder needs a distance; a thermometer needs a temperature.
Give a range the real part actually covers, taken from the datasheet's specification table.

PIN GEOMETRY. Lay pins out along one edge spaced by pinPitchMm unless the mechanical drawing shows
otherwise, keeping datasheet order. Every pin must fall inside widthMm by heightMm.

WHAT NOT TO DO. Do not invent a value the datasheet does not give. If an output impedance, a
threshold or a timing figure is absent, choose a defensible default AND add a line to "unresolved"
naming the field and the assumption. A populated "unresolved" list is a successful extraction; a
silently invented number is a failed one that nobody will catch.

Set provenance.confidence honestly: how much of this came from the document rather than from what
you know about parts like it.
`.trim();

export interface PromptInput {
  /** Free-text hint from the user, e.g. the part number they believe it is. */
  readonly hint?: string | undefined;
  /** Datasheet text, when the input is not a PDF. */
  readonly text?: string | undefined;
}

export function buildPrompt(input: PromptInput): string {
  const parts = [
    'Extract a component manifest from the datasheet provided.',
    '',
    'SCHEMA',
    SCHEMA_GUIDE,
    '',
    'RULES',
    RULES,
  ];

  if (input.hint) {
    parts.push('', `USER HINT: ${input.hint}`);
  }
  if (input.text) {
    parts.push('', 'DATASHEET TEXT', '---', input.text, '---');
  }

  parts.push('', 'Return only the JSON object.');
  return parts.join('\n');
}

/**
 * Ask for a repair rather than a fresh attempt.
 *
 * Re-running from scratch usually reproduces the same mistake; handing back the specific validation
 * failures fixes them far more often, and it keeps everything the model got right.
 */
export function buildRepairPrompt(previous: string, problems: readonly string[]): string {
  return [
    'The manifest you returned did not validate. Fix exactly these problems and return the whole',
    'corrected JSON object. Keep everything else unchanged.',
    '',
    'PROBLEMS',
    ...problems.map((p) => `- ${p}`),
    '',
    'Check the unit conversions first: a value that is a thousand or a million times too large is',
    'almost always milliamps, microseconds or kilohms taken at face value.',
    '',
    'YOUR PREVIOUS OUTPUT',
    previous,
  ].join('\n');
}
