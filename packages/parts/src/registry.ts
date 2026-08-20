/**
 * The part registry.
 *
 * A part declares the terminals it exposes, how big it is, and how it contributes to the circuit.
 * Everything the canvas needs to draw it and everything the solver needs to simulate it lives in
 * one place, so adding a component is one file rather than edits scattered across the UI.
 *
 * Geometry is in millimetres. Breadboards are on a 2.54 mm (0.1") pitch and so is every through-
 * hole part, so working in real units means a resistor's legs land in adjacent holes because the
 * arithmetic says so, not because a pixel offset was tuned by hand.
 */
import { Led, Resistor, type Device } from '@robo-journey/sim-core';
import {
  FULL_SIZE_BREADBOARD,
  HALF_SIZE_BREADBOARD,
  MINI_BREADBOARD,
  type BreadboardSpec,
} from '@robo-journey/sim-core';

/** Standard breadboard and header pitch: 0.1 inch. */
export const PITCH_MM = 2.54;

export type PartCategory = 'board' | 'passive' | 'output' | 'input' | 'power';

export interface PartPin {
  /** Pin name, which becomes the terminal id suffix. */
  readonly name: string;
  /** Position relative to the part's origin, millimetres. */
  readonly x: number;
  readonly y: number;
  /** Shown on hover and in the wiring UI. */
  readonly label?: string;
}

export interface BuildContext {
  /** This instance's id, for naming devices. */
  readonly partId: string;
  /** Resolve one of this part's pins to a circuit node. */
  node(pin: string): number;
  /** Instance properties, already merged over the definition's defaults. */
  readonly props: Record<string, unknown>;
  /** Register a device with the circuit. */
  add(device: Device): void;
}

/**
 * How to draw a part the canvas has no bespoke artwork for.
 *
 * Built-in components have hand-drawn shapes; anything arriving as a manifest gets a generic body
 * rendered from this. Without it a generated part draws as nothing at all and only its pin
 * hit-targets appear -- which looks exactly like a broken component.
 */
export interface PartAppearance {
  readonly bodyColor: string;
  /** Drawn across the body. Usually the part number. */
  readonly title: string;
  /** Smaller line beneath, usually the package type. */
  readonly subtitle?: string;
  /** Marks it as extracted rather than built in. */
  readonly generated?: boolean;
}

export interface PartDefinition {
  readonly type: string;
  readonly label: string;
  readonly category: PartCategory;
  /** Bounding size in millimetres, for canvas layout and hit testing. */
  readonly width: number;
  readonly height: number;
  readonly pins: readonly PartPin[];
  readonly defaults: Record<string, unknown>;
  /**
   * Internal connectivity, for parts that are wiring rather than components.
   *
   * A breadboard's strips are the only current use: they join terminals without contributing any
   * device. Returning pairs rather than mutating a netlist keeps this declarative.
   */
  readonly internalSpec?: BreadboardSpec;
  /** Contribute devices. Omitted for parts that are pure connectivity. */
  build?(ctx: BuildContext): void;
  /** Present on parts without bespoke artwork, telling the canvas how to draw a generic body. */
  readonly appearance?: PartAppearance;
}

// ---------------------------------------------------------------------------------------------

/**
 * Breadboards.
 *
 * Three real sizes, because the choice matters on screen as much as on a desk: a 170-point mini is
 * the right board for an LED and a resistor, and a 30-column half-size beside them is mostly empty
 * plastic. Height depends on whether the board carries power rails.
 */
function breadboard(
  type: string,
  label: string,
  spec: BreadboardSpec,
): PartDefinition {
  // Numbered rows occupy 10 pitches plus margins; rails add two pitches at each edge.
  const rows = spec.powerRails ? 17 : 13;
  return {
    type,
    label,
    category: 'board',
    width: (spec.columns + 2) * PITCH_MM,
    height: rows * PITCH_MM,
    pins: [],
    defaults: {},
    internalSpec: spec,
  };
}

const BREADBOARD_MINI = breadboard('breadboard-mini', 'Breadboard (mini, 170pt)', MINI_BREADBOARD);
const BREADBOARD_HALF = breadboard('breadboard-half', 'Breadboard (half, 400pt)', HALF_SIZE_BREADBOARD);
const BREADBOARD_FULL = breadboard('breadboard-full', 'Breadboard (full, 830pt)', FULL_SIZE_BREADBOARD);

/**
 * Arduino Uno.
 *
 * Handled specially by the builder: the board brings its own MCU, supply and pin models, so this
 * definition exists for the canvas -- artwork size and header geometry -- rather than to build
 * devices. Pin positions follow the real header spacing, including the notorious 0.05" offset
 * between D7 and D8 that stops standard 0.1" protoboard sitting flat.
 */
/**
 * Arduino Uno R3.
 *
 * Handled specially by the builder: the board brings its own MCU, supply and per-pin electrical
 * models, so this definition exists for the canvas -- artwork size and header geometry -- rather
 * than to build devices.
 *
 * Positions follow the real R3 header layout, including the 0.16" jog between D7 and D8 that stops
 * standard 0.1" protoboard sitting flat on an Uno. The canvas draws its sockets straight from this
 * list, so the artwork and the netlist cannot drift apart.
 */
const UNO_PIN_PITCH = PITCH_MM;
/** y of the digital header, from the top edge. */
const UNO_TOP_Y = 2.0;
/** y of the power and analog headers, from the top edge. */
const UNO_BOTTOM_Y = 51.4;

/** Digital header, right bank: D8..D13 plus GND and AREF, laid out right to left. */
const UNO_DIGITAL_HIGH = ['AREF', 'GND3', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8'];
/** Digital header, left bank: D0..D7. */
const UNO_DIGITAL_LOW = ['D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'];
/** Power header, left to right. */
const UNO_POWER = ['IOREF', 'RESET', '3V3', '5V', 'GND', 'GND2', 'VIN'];
/** Analog header, left to right. */
const UNO_ANALOG = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'];

/** Silkscreen text, where it differs from the terminal name. */
const UNO_LABELS: Record<string, string> = {
  GND: 'GND',
  GND2: 'GND',
  GND3: 'GND',
  '3V3': '3V3',
  D0: 'RX0',
  D1: 'TX1',
};

function unoPins(): PartPin[] {
  const pins: PartPin[] = [];

  // Right bank runs leftward from x = 60.96 (AREF nearest the right edge).
  UNO_DIGITAL_HIGH.forEach((name, i) => {
    pins.push({ name, x: 60.96 - i * UNO_PIN_PITCH, y: UNO_TOP_Y, label: UNO_LABELS[name] ?? name });
  });
  // Left bank starts after the 0.16" jog: D7 sits 3.81 mm left of D8, not 2.54.
  const d8x = 60.96 - (UNO_DIGITAL_HIGH.length - 1) * UNO_PIN_PITCH;
  UNO_DIGITAL_LOW.forEach((name, i) => {
    pins.push({
      name,
      x: d8x - 3.81 - i * UNO_PIN_PITCH,
      y: UNO_TOP_Y,
      label: UNO_LABELS[name] ?? name,
    });
  });

  UNO_POWER.forEach((name, i) => {
    pins.push({ name, x: 16.51 + i * UNO_PIN_PITCH, y: UNO_BOTTOM_Y, label: UNO_LABELS[name] ?? name });
  });
  UNO_ANALOG.forEach((name, i) => {
    pins.push({ name, x: 39.37 + i * UNO_PIN_PITCH, y: UNO_BOTTOM_Y, label: name });
  });

  return pins;
}

const ARDUINO_UNO: PartDefinition = {
  type: 'arduino-uno',
  label: 'Arduino Uno',
  category: 'board',
  width: 68.6,
  height: 53.4,
  pins: unoPins(),
  defaults: {},
};

/** Through-hole resistor. Legs on a 0.4" span, the standard bend for a breadboard. */
const RESISTOR: PartDefinition = {
  type: 'resistor',
  label: 'Resistor',
  category: 'passive',
  width: 4 * PITCH_MM,
  height: PITCH_MM,
  pins: [
    { name: 'a', x: 0, y: 0, label: 'A' },
    { name: 'b', x: 4 * PITCH_MM, y: 0, label: 'B' },
  ],
  defaults: { ohms: 220 },
  build(ctx) {
    const ohms = Number(ctx.props.ohms ?? 220);
    ctx.add(new Resistor(ctx.partId, ctx.node('a'), ctx.node('b'), ohms));
  },
};

/** 5 mm LED. Anode is the long leg, as on the part. */
const LED: PartDefinition = {
  type: 'led',
  label: 'LED',
  category: 'output',
  width: 5,
  height: 5,
  pins: [
    { name: 'anode', x: 0, y: 0, label: 'Anode (+)' },
    { name: 'cathode', x: PITCH_MM, y: 0, label: 'Cathode (-)' },
  ],
  defaults: { color: 'red' },
  build(ctx) {
    const color = String(ctx.props.color ?? 'red') as 'red' | 'yellow' | 'green' | 'blue' | 'white';
    ctx.add(new Led(ctx.partId, ctx.node('anode'), ctx.node('cathode'), color));
  },
};

/** Momentary tactile switch. The four legs are two pairs, permanently bridged inside the part. */
const PUSHBUTTON: PartDefinition = {
  type: 'pushbutton',
  label: 'Pushbutton',
  category: 'input',
  width: 2 * PITCH_MM,
  height: 2 * PITCH_MM,
  pins: [
    { name: '1a', x: 0, y: 0, label: '1' },
    { name: '2a', x: 2 * PITCH_MM, y: 0, label: '2' },
    { name: '1b', x: 0, y: 2 * PITCH_MM, label: '1' },
    { name: '2b', x: 2 * PITCH_MM, y: 2 * PITCH_MM, label: '2' },
  ],
  defaults: { pressed: false },
  build(ctx) {
    // Legs 1a/1b are one contact and 2a/2b the other -- wired together inside the switch body,
    // which is why a button dropped across the breadboard channel works and one dropped along a
    // single strip does nothing. Model the internal bridges as near-ideal wires.
    ctx.add(new Resistor(`${ctx.partId}:bridge1`, ctx.node('1a'), ctx.node('1b'), 1e-3));
    ctx.add(new Resistor(`${ctx.partId}:bridge2`, ctx.node('2a'), ctx.node('2b'), 1e-3));
    // The contact itself: closed is milliohms, open is gigaohms.
    const pressed = ctx.props.pressed === true;
    ctx.add(
      new Resistor(`${ctx.partId}:contact`, ctx.node('1a'), ctx.node('2a'), pressed ? 0.05 : 1e9),
    );
  },
};

const DEFINITIONS: readonly PartDefinition[] = [
  ARDUINO_UNO,
  BREADBOARD_MINI,
  BREADBOARD_HALF,
  BREADBOARD_FULL,
  RESISTOR,
  LED,
  PUSHBUTTON,
];

const BY_TYPE = new Map(DEFINITIONS.map((d) => [d.type, d]));

/**
 * Parts added at run time, from manifests.
 *
 * Kept separate from the built-ins so the two can be told apart in the palette and so a generated
 * part can be replaced or removed without disturbing the library. This is the mechanism that lets
 * the platform hold components nobody compiled in.
 */
const REGISTERED = new Map<string, PartDefinition>();

export function partDefinition(type: string): PartDefinition {
  const definition = REGISTERED.get(type) ?? BY_TYPE.get(type);
  if (!definition) throw new Error(`Unknown part type "${type}"`);
  return definition;
}

/** Every part, built-in and registered. */
export function allParts(): readonly PartDefinition[] {
  return [...DEFINITIONS, ...REGISTERED.values()];
}

/** Just the built-in library. */
export function builtinParts(): readonly PartDefinition[] {
  return DEFINITIONS;
}

/** Parts added at run time. */
export function registeredParts(): readonly PartDefinition[] {
  return [...REGISTERED.values()];
}

/**
 * Add a part at run time.
 *
 * Refuses to shadow a built-in: a generated component quietly replacing the LED would make every
 * existing project behave differently with no indication why.
 */
export function registerPart(definition: PartDefinition): void {
  if (BY_TYPE.has(definition.type)) {
    throw new Error(`"${definition.type}" is a built-in part and cannot be replaced`);
  }
  REGISTERED.set(definition.type, definition);
}

export function unregisterPart(type: string): boolean {
  return REGISTERED.delete(type);
}

/** True when a type is registered rather than compiled in. */
export function isRegistered(type: string): boolean {
  return REGISTERED.has(type);
}

export {
  ARDUINO_UNO,
  BREADBOARD_FULL,
  BREADBOARD_HALF,
  BREADBOARD_MINI,
  LED,
  PUSHBUTTON,
  RESISTOR,
};
