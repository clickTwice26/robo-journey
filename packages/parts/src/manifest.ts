/**
 * Component manifest: a component described as data rather than as code.
 *
 * Everything in the built-in library could have been a manifest; the point of making it data is
 * that a component can then arrive at runtime -- extracted from a datasheet, shared as a file,
 * edited by hand -- without rebuilding the app. That is what lets the platform hold parts nobody
 * anticipated.
 *
 * Two principles run through the schema:
 *
 * 1. **Every number carries its datasheet meaning.** Not `threshold: 2.4` but `vih`, in volts, with
 *    the page it came from. A simulator whose numbers cannot be traced back to a datasheet is a
 *    guess with a nice interface.
 *
 * 2. **Extraction is never trusted.** `provenance` records where a manifest came from, how
 *    confident the extractor was, and what it could not resolve. A part generated from a PDF is
 *    marked unverified until a human says otherwise, because the whole premise of this project is
 *    that the simulation tells you the truth.
 */
import { z } from 'zod';

/** Millimetres, the unit the canvas and every datasheet mechanical drawing use. */
const Mm = z.number().finite();
const Volts = z.number().finite();
const Amps = z.number().finite();
const Ohms = z.number().positive();

// ---------------------------------------------------------------------------------------------
// Pin electrical models
// ---------------------------------------------------------------------------------------------

/**
 * How a pin behaves electrically.
 *
 * These are the same primitives the solver already speaks -- resistances, sources, diodes -- so a
 * manifest cannot describe something the engine has no way to simulate.
 */
export const PinModelSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('power'),
    /** Nominal supply this pin expects. */
    vNom: Volts,
    vMin: Volts.optional(),
    vMax: Volts.optional(),
    /** Quiescent current drawn, amps. */
    iQuiescent: Amps.default(0),
  }),

  z.object({ kind: z.literal('ground') }),

  z.object({
    kind: z.literal('digital-in'),
    /** Minimum voltage read as HIGH. */
    vih: Volts,
    /** Maximum voltage read as LOW. */
    vil: Volts,
    /** Input impedance; how hard the pin loads whatever drives it. */
    impedanceOhms: Ohms.default(1e8),
    /** Internal pull-up or pull-down, if the part has one. */
    pull: z.enum(['none', 'up', 'down']).default('none'),
    pullOhms: Ohms.optional(),
  }),

  z.object({
    kind: z.literal('digital-out'),
    /** Output impedance; why a driven pin is not exactly at the rail. */
    impedanceOhms: Ohms.default(50),
    /** Absolute maximum the pin can source and sink. */
    sourceMaxA: Amps.default(0.02),
    sinkMaxA: Amps.default(0.02),
    /** True for open-drain outputs, which can only pull down. */
    openDrain: z.boolean().default(false),
  }),

  z.object({
    kind: z.literal('analog-in'),
    impedanceOhms: Ohms.default(1e8),
  }),

  z.object({
    kind: z.literal('analog-out'),
    impedanceOhms: Ohms.default(100),
  }),

  z.object({
    /** A fixed passive between this pin and another: a built-in series or pull resistor. */
    kind: z.literal('passive'),
    toPin: z.string(),
    ohms: Ohms.optional(),
    farads: z.number().positive().optional(),
  }),

  z.object({
    kind: z.literal('led'),
    cathodePin: z.string(),
    color: z
      .enum(['infrared', 'red', 'orange', 'yellow', 'green', 'blue', 'white', 'uv'])
      .default('red'),
    /** Forward voltage at the datasheet's test current. */
    vf: Volts.default(2),
    ifNominalA: Amps.default(0.02),
    ifMaxA: Amps.default(0.03),
  }),

  /** Not internally connected. Modelled explicitly so a manifest can say so rather than omit it. */
  z.object({ kind: z.literal('nc') }),
]);

export type PinModel = z.infer<typeof PinModelSchema>;

// ---------------------------------------------------------------------------------------------
// Pins and package
// ---------------------------------------------------------------------------------------------

export const PinSchema = z.object({
  /** Datasheet name, e.g. "VCC", "SDA", "TRIG". Used as the terminal id suffix. */
  name: z.string().min(1),
  /** Physical pin number, where the package has one. */
  number: z.number().int().positive().optional(),
  /** Position relative to the part origin, millimetres. */
  x: Mm,
  y: Mm,
  /** One-line description from the datasheet, shown on hover. */
  description: z.string().default(''),
  model: PinModelSchema,
});

export const PackageSchema = z.object({
  /** DIP-8, SIP-4, module, TO-92 -- free text, since packages are endless. */
  type: z.string().default('module'),
  widthMm: Mm.positive(),
  heightMm: Mm.positive(),
  /** 2.54 for anything breadboard-compatible. */
  pinPitchMm: Mm.positive().default(2.54),
  /** Body colour for the canvas, when the part has a recognisable one. */
  bodyColor: z.string().default('#2b3038'),
});

// ---------------------------------------------------------------------------------------------
// Simulated physical inputs
// ---------------------------------------------------------------------------------------------

/**
 * A quantity the *world* supplies to the component: distance for a rangefinder, temperature for a
 * thermometer, light for an LDR.
 *
 * Without this a sensor has nothing to sense. The UI turns each one into a control, which is how a
 * simulated HC-SR04 gets told there is a wall 40 cm away.
 */
export const StateVariableSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  unit: z.string().default(''),
  min: z.number(),
  max: z.number(),
  default: z.number(),
  step: z.number().positive().default(1),
  /**
   * The physical quantity this variable *is*, when it is one the workspace can supply.
   *
   * Declaring it is what lets a flame placed on the canvas reach a flame sensor: the environment
   * knows what a flame emits and the manifest knows what the sensor listens for, and neither has
   * to know about the other. Left unset for anything the world has no way to produce -- a
   * register's contents, an accelerometer axis -- which keeps those on their own control.
   */
  quantity: z
    .enum([
      'light',
      'sound',
      'temperature',
      'flame',
      'motion',
      'magnet',
      'distance',
      'gas',
      'moisture',
      'vibration',
    ])
    .optional(),
});

// ---------------------------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------------------------

/** One register in a memory-mapped peripheral. */
export const RegisterSchema = z.object({
  address: z.number().int().nonnegative(),
  name: z.string().min(1),
  /** Power-on value. */
  reset: z.number().int().nonnegative().default(0),
  access: z.enum(['r', 'w', 'rw']).default('rw'),
  /** When set, reads return this state variable scaled by `scale` plus `offset`. */
  fromState: z.string().optional(),
  scale: z.number().default(1),
  offset: z.number().default(0),
  /** Register width in bytes, for values that span several addresses. */
  bytes: z.number().int().min(1).max(4).default(1),
});

export const BehaviorSchema = z.discriminatedUnion('kind', [
  /** Purely passive: the pin models are the whole story. */
  z.object({ kind: z.literal('passive') }),

  /**
   * An analog output that tracks a state variable through a linear transfer function.
   *
   * Covers the enormous family of analog sensors -- TMP36, LM35, potentiometers, current shunts --
   * whose datasheet gives exactly `Vout = scale * quantity + offset`.
   */
  z.object({
    kind: z.literal('analog-sensor'),
    outputPin: z.string(),
    state: z.string(),
    /** Volts per unit of the state variable. */
    voltsPerUnit: z.number(),
    offsetVolts: Volts.default(0),
    /** Clamped to the supply rails, as a real part is. */
    clampToSupply: z.boolean().default(true),
  }),

  /**
   * A resistance that tracks a state variable: LDRs, thermistors, potentiometers, flex sensors.
   */
  z.object({
    kind: z.literal('variable-resistor'),
    pinA: z.string(),
    pinB: z.string(),
    state: z.string(),
    /** Resistance at the state variable's minimum and maximum. Interpolated logarithmically. */
    ohmsAtMin: Ohms,
    ohmsAtMax: Ohms,
  }),

  /**
   * I2C peripheral with a register file.
   *
   * Covers most sensor and display breakouts: the host writes a register address then reads or
   * writes bytes. Register reads can be backed by a state variable, which is how a simulated
   * thermometer returns a temperature the user chose.
   */
  z.object({
    kind: z.literal('i2c-peripheral'),
    address: z.number().int().min(0).max(0x7f),
    sdaPin: z.string(),
    sclPin: z.string(),
    registers: z.array(RegisterSchema).default([]),
  }),

  /**
   * SPI peripheral with a register file.
   *
   * The addressing fields matter more here than they do on I2C. SPI has no addressing of its own,
   * so each family invented its own framing on top, and the differences are small enough to be
   * easy to get wrong: nearly every sensor sends one command byte carrying a read/write flag and a
   * register address, but which bit is the flag and which polarity means "read" varies from part
   * to part.
   */
  z.object({
    kind: z.literal('spi-peripheral'),
    mosiPin: z.string(),
    misoPin: z.string(),
    sckPin: z.string(),
    csPin: z.string(),
    /** SPI mode, 0-3, from the datasheet's CPOL and CPHA. */
    mode: z.number().int().min(0).max(3).default(0),
    /** Chip select polarity. Active-low on essentially everything. */
    csActiveLow: z.boolean().default(true),
    bitOrder: z.enum(['msbFirst', 'lsbFirst']).default('msbFirst'),
    /** Maximum SCK the datasheet allows, hertz. */
    maxClockHz: z.number().positive().optional(),
    /**
     * `register` for the command-byte convention; `stream` for parts with no addressing at all,
     * such as shift registers and most graphic displays.
     */
    addressing: z.enum(['register', 'stream']).default('register'),
    /** Bit of the command byte holding the read/write flag. */
    readBitPosition: z.number().int().min(0).max(7).default(7),
    /** Value of that bit meaning "read". 1 on most parts; a few invert it. */
    readBitValue: z.union([z.literal(0), z.literal(1)]).default(1),
    /** Whether the register address advances between data bytes in one transaction. */
    autoIncrement: z.boolean().default(true),
    registers: z.array(RegisterSchema).default([]),
  }),

  /**
   * A linear voltage regulator.
   *
   * Present in nearly every project and absent from every simulator, which is why a whole class of
   * power problems only ever shows up on the bench. Two numbers do the work: the dropout decides
   * whether the thing regulates at all on the supply it has been given, and the thermal resistance
   * decides whether it survives doing so. A 7805 fed 12 V at half an amp is a correct circuit that
   * shuts down after half a minute, and nothing about the schematic says so.
   */
  z.object({
    kind: z.literal('regulator'),
    inputPin: z.string(),
    outputPin: z.string(),
    groundPin: z.string(),
    outputVolts: Volts,
    /** Headroom above the output the part needs. ~2 V for a 7805, ~1.1 V for an AMS1117. */
    dropoutVolts: Volts.default(2),
    /** The part's own consumption, which returns through the ground pin. */
    quiescentAmps: Amps.default(5e-3),
    maxOutputAmps: Amps.default(1),
    /** From the datasheet's load-regulation figure. */
    outputImpedanceOhms: Ohms.default(0.02),
    /**
     * Junction-to-ambient thermal resistance, K/W.
     *
     * The datasheet gives several: use the free-air figure unless the design has a heatsink. A
     * bare TO-220 is around 65, the same part on a decent heatsink around 5, an SOT-223 around 110.
     */
    thermalOhmsPerWatt: z.number().positive().default(65),
    thermalShutdownC: z.number().default(150),
    /** Thermal mass, J/K. Sets how long it takes to overheat, not whether it does. */
    thermalMassJPerK: z.number().positive().default(0.9),
  }),

  /**
   * Trigger-and-echo rangefinders: HC-SR04 and its many clones.
   *
   * The host pulses TRIG, the part waits, then emits an ECHO pulse whose width encodes the
   * measurement. Every number here appears in the datasheet.
   */
  z.object({
    kind: z.literal('pulse-echo'),
    triggerPin: z.string(),
    echoPin: z.string(),
    state: z.string(),
    /** Minimum trigger pulse the part will accept, seconds. */
    minTriggerSeconds: z.number().positive().default(10e-6),
    /** Delay between trigger and echo rising, seconds. */
    responseDelaySeconds: z.number().nonnegative().default(460e-6),
    /** Echo width per unit of the state variable, seconds. */
    secondsPerUnit: z.number().positive(),
    /** Width reported when nothing is in range, seconds. */
    timeoutSeconds: z.number().positive().default(38e-3),
  }),

  /**
   * Pulse-width driven actuators: hobby servos and ESCs.
   *
   * The host sends a pulse every ~20 ms and the part's position tracks its width.
   */
  z.object({
    kind: z.literal('pwm-actuator'),
    signalPin: z.string(),
    /** Pulse width at each end of travel, seconds. */
    minPulseSeconds: z.number().positive().default(1e-3),
    maxPulseSeconds: z.number().positive().default(2e-3),
    /** Travel in the part's own units, usually degrees. */
    minPosition: z.number().default(0),
    maxPosition: z.number().default(180),
    /** How fast it can move, units per second. Position lags the command, as a real servo does. */
    slewPerSecond: z.number().positive().default(400),
    /** Current drawn while moving, which is what browns out a board on USB power. */
    movingCurrentA: Amps.default(0.25),
    holdCurrentA: Amps.default(0.01),
  }),

  /**
   * A bipolar junction transistor.
   *
   * Discrete semiconductors do not fit any of the sensor archetypes: they have no state variable
   * and no protocol, they simply amplify. Simulated by a real Ebers-Moll model, so a transistor
   * extracted from a datasheet switches, saturates and drops its ~0.7 V like the part it came from.
   */
  z.object({
    kind: z.literal('transistor'),
    polarity: z.enum(['npn', 'pnp']),
    collectorPin: z.string(),
    basePin: z.string(),
    emitterPin: z.string(),
    /** Forward current gain, the datasheet's hFE. Use the typical figure, not the minimum. */
    forwardBeta: z.number().positive().default(200),
    /** Reverse gain. Rarely quoted; it is what makes saturation saturate. */
    reverseBeta: z.number().positive().default(4),
    /** Transport saturation current, amps. Around 1e-14 for a small-signal device. */
    saturationCurrent: z.number().positive().default(1e-14),
  }),

  /**
   * A MOSFET.
   *
   * The modern switching device: every motor driver, every PWM power stage. Level 1 is enough to
   * answer whether the available gate voltage turns it fully on and how much it dissipates, which
   * is what people actually need to know.
   */
  z.object({
    kind: z.literal('mosfet'),
    channel: z.enum(['n', 'p']),
    drainPin: z.string(),
    gatePin: z.string(),
    sourcePin: z.string(),
    /** Gate threshold, the datasheet's VGS(th). Use the typical figure. */
    thresholdVolts: Volts.default(2),
    /**
     * Transconductance parameter, A/V^2.
     *
     * Datasheets give a drain current at a stated VGS instead. Derive it from that point:
     * `k = 2 * Id / (Vgs - Vth)^2`.
     */
    k: z.number().positive().default(1),
    /** On-resistance, the datasheet's RDS(on). */
    rdsOnOhms: Ohms.default(0.1),
    /** Channel-length modulation. 0.02 is a reasonable assumption when not given. */
    lambda: z.number().nonnegative().default(0.02),
  }),

  /**
   * An operational amplifier.
   *
   * The rail headroom is the number that matters most in practice: an LM358 cannot get within
   * about 1.5 V of its positive rail, which is why so many single-supply circuits built with one
   * behave nothing like the textbook.
   */
  z.object({
    kind: z.literal('op-amp'),
    nonInvertingPin: z.string(),
    invertingPin: z.string(),
    outputPin: z.string(),
    positiveRailPin: z.string(),
    negativeRailPin: z.string(),
    /** Open-loop DC gain. 100 dB is 100000. */
    openLoopGain: z.number().positive().default(100_000),
    outputImpedanceOhms: Ohms.default(100),
    inputImpedanceOhms: Ohms.default(1e9),
    /** How close the output can get to each rail, volts. */
    headroomHighVolts: Volts.default(1.5),
    headroomLowVolts: Volts.default(0.02),
  }),

  /**
   * A diode.
   *
   * After the resistor, the part that turns up in the most circuits: flyback across every relay
   * and motor, reverse-polarity protection on every supply, rectification in every power stage.
   * Simulated by the same Shockley model the LED uses, so a 1N4007 drops its real 0.7 V under load
   * rather than an assumed one, and a signal diode drops less -- which is the entire reason anyone
   * picks one over the other.
   */
  z.object({
    kind: z.literal('diode'),
    anodePin: z.string(),
    cathodePin: z.string(),
    /** Saturation current, amps. Around 1e-9 for a rectifier, 1e-12 for a small-signal part. */
    saturationCurrent: z.number().positive().default(1e-9),
    /** Emission coefficient N. Near 1 for a signal diode, closer to 2 for a power rectifier. */
    emissionCoefficient: z.number().positive().default(1.5),
    /** Bulk series resistance, ohms. What makes the forward drop grow with current. */
    seriesResistanceOhms: Ohms.default(0.05),
  }),

  /**
   * A capacitor.
   *
   * Modelled with a real companion model rather than ignored, so an RC delay takes the time it
   * actually takes and a decoupling capacitor holds a rail up through a current spike. A simulator
   * that treated capacitors as open circuits would get every timing circuit wrong and say nothing
   * about it.
   */
  z.object({
    kind: z.literal('capacitor'),
    pinA: z.string(),
    pinB: z.string(),
    farads: z.number().positive(),
    /** Working voltage. Exceeding it is how electrolytics fail, loudly. */
    ratedVolts: Volts.optional(),
    /** True for electrolytics and tantalums, which are destroyed by reverse polarity. */
    polarised: z.boolean().default(false),
  }),

  /**
   * A supply the user brings to the circuit: a battery, a cell, a bench supply.
   *
   * Modelled with its internal resistance, which is the only reason it is worth modelling at all.
   * An ideal 9 V source makes every design work; a real 9 V alkaline is 1.7 ohm behind that EMF and
   * sags to five volts under a stalled motor, and a simulator that hides this cannot explain why
   * the servo project browns out on a battery and not on USB.
   */
  z.object({
    kind: z.literal('source'),
    positivePin: z.string(),
    negativePin: z.string(),
    /** Open-circuit terminal voltage, volts. */
    volts: Volts,
    /**
     * Internal resistance, ohms.
     *
     * Datasheets for cells give it directly; for a battery pack it is roughly the cell figure times
     * the number in series. A bench supply is a few milliohms and effectively ideal.
     */
    internalOhms: Ohms.default(0.5),
  }),

  /**
   * A three-terminal potentiometer.
   *
   * Not the same as `variable-resistor`, and the difference is what most beginner circuits depend
   * on: a pot across a supply is a divider whose wiper sits at a fraction of it, independent of
   * the track's total resistance.
   */
  z.object({
    kind: z.literal('potentiometer'),
    terminalAPin: z.string(),
    wiperPin: z.string(),
    terminalBPin: z.string(),
    totalOhms: Ohms.default(10_000),
    taper: z.enum(['linear', 'log']).default('linear'),
    /** State variable driving the knob, 0 at terminal A and 1 at terminal B. */
    state: z.string().optional(),
  }),

  /**
   * A digital output whose level follows a threshold on a state variable.
   *
   * Covers comparator modules, PIR sensors, reed switches, limit switches and tilt sensors.
   */
  z.object({
    kind: z.literal('threshold-switch'),
    outputPin: z.string(),
    state: z.string(),
    threshold: z.number(),
    /** True when the output goes low above the threshold, as most modules do. */
    activeLow: z.boolean().default(true),
    /** Hysteresis in state units, so a noisy input does not chatter. */
    hysteresis: z.number().nonnegative().default(0),
  }),
]);

export type Behavior = z.infer<typeof BehaviorSchema>;
export type Register = z.infer<typeof RegisterSchema>;

// ---------------------------------------------------------------------------------------------
// Limits and provenance
// ---------------------------------------------------------------------------------------------

export const LimitsSchema = z.object({
  /** Absolute maximum supply voltage. Exceeding it is how parts die. */
  vccMaxVolts: Volts.optional(),
  vccMinVolts: Volts.optional(),
  /** Absolute maximum current through any one pin. */
  pinMaxAmps: Amps.optional(),
  /** Absolute maximum total current. */
  totalMaxAmps: Amps.optional(),
  operatingTempMinC: z.number().optional(),
  operatingTempMaxC: z.number().optional(),
});

/**
 * Where a manifest came from and how much to trust it.
 *
 * `unresolved` is the most important field. A datasheet extraction that silently guesses is worse
 * than one that says "the datasheet gives no output impedance, 50 ohm assumed" -- the first makes
 * the simulator quietly wrong, the second tells you which number to check.
 */
export const ProvenanceSchema = z.object({
  source: z.enum(['builtin', 'datasheet-ai', 'hand-written', 'imported']),
  /** Model that produced it, when generated. */
  model: z.string().optional(),
  datasheetName: z.string().optional(),
  datasheetUrl: z.string().optional(),
  /** ISO timestamp. */
  extractedAt: z.string().optional(),
  /** Extractor's own confidence, 0 to 1. */
  confidence: z.number().min(0).max(1).optional(),
  /** Things the datasheet did not specify, with the assumption made instead. */
  unresolved: z.array(z.string()).default([]),
  /** Set once a human has checked the numbers against the datasheet. */
  verified: z.boolean().default(false),
});

// ---------------------------------------------------------------------------------------------

export const ComponentManifestSchema = z.object({
  schemaVersion: z.literal(1),
  /** Stable identifier, used as the part type. Lower-case, hyphenated. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'ids are lower-case and hyphenated'),
  name: z.string().min(1),
  manufacturer: z.string().default(''),
  partNumber: z.string().default(''),
  category: z.enum(['sensor', 'actuator', 'display', 'passive', 'power', 'logic', 'module']),
  description: z.string().default(''),

  package: PackageSchema,
  pins: z.array(PinSchema).min(1),
  state: z.array(StateVariableSchema).default([]),
  behavior: BehaviorSchema,
  limits: LimitsSchema.default({}),
  provenance: ProvenanceSchema,
});

export type ComponentManifest = z.infer<typeof ComponentManifestSchema>;
export type ManifestPin = z.infer<typeof PinSchema>;
export type StateVariable = z.infer<typeof StateVariableSchema>;
export type Limits = z.infer<typeof LimitsSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Parse and validate a manifest structurally. Semantic checks live in `validateManifest`. */
export function parseManifest(input: unknown): ComponentManifest {
  return ComponentManifestSchema.parse(input);
}
