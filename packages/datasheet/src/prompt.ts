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
export const PROMPT_VERSION = 1;

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
    "mode": 0-3, "registers": [ ... ] }

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
  Is it only resistors, capacitors, diodes or LEDs?                   -> passive
If the part genuinely fits none of these, pick the closest, set confidence below 0.5, and say so in
unresolved.

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
