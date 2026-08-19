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
  HALF_SIZE_BREADBOARD,
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
}

// ---------------------------------------------------------------------------------------------

/** Half-size breadboard: 30 columns, split power rails. */
const BREADBOARD_HALF: PartDefinition = {
  type: 'breadboard-half',
  label: 'Breadboard (half)',
  category: 'board',
  // 30 columns plus a margin, and 10 rows plus the two rail pairs.
  width: 32 * PITCH_MM,
  height: 17 * PITCH_MM,
  pins: [],
  defaults: {},
  internalSpec: HALF_SIZE_BREADBOARD,
};

/**
 * Arduino Uno.
 *
 * Handled specially by the builder: the board brings its own MCU, supply and pin models, so this
 * definition exists for the canvas -- artwork size and header geometry -- rather than to build
 * devices. Pin positions follow the real header spacing, including the notorious 0.05" offset
 * between D7 and D8 that stops standard 0.1" protoboard sitting flat.
 */
const ARDUINO_UNO: PartDefinition = {
  type: 'arduino-uno',
  label: 'Arduino Uno',
  category: 'board',
  width: 68.6,
  height: 53.4,
  pins: [
    // Digital header, right to left along the top edge.
    ...['D13', 'D12', 'D11', 'D10', 'D9', 'D8'].map((name, i) => ({
      name,
      x: 62.0 - i * PITCH_MM,
      y: 2.5,
      label: name,
    })),
    ...['D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'].map((name, i) => ({
      name,
      // The real 0.05" jog between the two digital banks.
      x: 43.2 - i * PITCH_MM,
      y: 2.5,
      label: name,
    })),
    // Analog header along the bottom edge.
    ...['A0', 'A1', 'A2', 'A3', 'A4', 'A5'].map((name, i) => ({
      name,
      x: 40.6 + i * PITCH_MM,
      y: 50.9,
      label: name,
    })),
    // Power header.
    { name: '5V', x: 25.4, y: 50.9, label: '5V' },
    { name: '3V3', x: 22.9, y: 50.9, label: '3.3V' },
    { name: 'GND', x: 30.5, y: 50.9, label: 'GND' },
    { name: 'GND2', x: 33.0, y: 50.9, label: 'GND' },
    { name: 'VIN', x: 35.6, y: 50.9, label: 'VIN' },
  ],
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
  BREADBOARD_HALF,
  ARDUINO_UNO,
  RESISTOR,
  LED,
  PUSHBUTTON,
];

const BY_TYPE = new Map(DEFINITIONS.map((d) => [d.type, d]));

export function partDefinition(type: string): PartDefinition {
  const definition = BY_TYPE.get(type);
  if (!definition) throw new Error(`Unknown part type "${type}"`);
  return definition;
}

export function allParts(): readonly PartDefinition[] {
  return DEFINITIONS;
}

export { BREADBOARD_HALF, ARDUINO_UNO, RESISTOR, LED, PUSHBUTTON };
