/**
 * Shared pieces for describing built-in components.
 *
 * Thirty manifests written out longhand is thirty chances to mistype a pin pitch, and the mistake
 * is invisible until a part's legs miss the breadboard holes. Pin rows are computed from the
 * 2.54 mm pitch that every through-hole part actually uses, and the electrical models people
 * repeat -- a supply pin, a ground pin, a CMOS input -- are named once.
 */
import type { Behavior, ComponentManifest, ManifestPin, PinModel, Register } from '../manifest.js';

export const PITCH = 2.54;

/** A supply pin, with the quiescent draw that lets a weak rail be seen to sag. */
export const power = (vNom: number, over: Partial<Extract<PinModel, { kind: 'power' }>> = {}): PinModel => ({
  kind: 'power',
  vNom,
  iQuiescent: 0,
  ...over,
});

export const ground = (): PinModel => ({ kind: 'ground' });

/** CMOS-ish input thresholds, which most modules are. Overridden where a datasheet differs. */
export const digitalIn = (
  supply = 5,
  over: Partial<Extract<PinModel, { kind: 'digital-in' }>> = {},
): PinModel => ({
  kind: 'digital-in',
  vih: supply * 0.7,
  vil: supply * 0.3,
  impedanceOhms: 1e8,
  pull: 'none',
  ...over,
});

export const digitalOut = (
  over: Partial<Extract<PinModel, { kind: 'digital-out' }>> = {},
): PinModel => ({
  kind: 'digital-out',
  impedanceOhms: 50,
  // An open-drain pin can only pull down, so its source rating is zero by definition rather than
  // by omission. Stating it here keeps every call site from having to remember.
  sourceMaxA: over.openDrain ? 0 : 0.02,
  sinkMaxA: 0.02,
  openDrain: false,
  ...over,
});

export const analogOut = (impedanceOhms = 100): PinModel => ({ kind: 'analog-out', impedanceOhms });
export const analogIn = (impedanceOhms = 1e8): PinModel => ({ kind: 'analog-in', impedanceOhms });
export const notConnected = (): PinModel => ({ kind: 'nc' });

export interface PinSpec {
  readonly name: string;
  readonly model: PinModel;
  readonly description?: string;
}

/**
 * A row of pins on the standard pitch, as a header or one side of a package.
 *
 * `startX` is where the first pin sits; everything after it follows at 2.54 mm, which is what makes
 * a part's legs land in adjacent breadboard holes because the arithmetic says so rather than
 * because an offset was nudged until it looked right.
 */
export function row(specs: readonly PinSpec[], y: number, startX = PITCH): ManifestPin[] {
  return specs.map((spec, index) => ({
    name: spec.name,
    x: startX + index * PITCH,
    y,
    description: spec.description ?? '',
    model: spec.model,
  }));
}

/**
 * A dual in-line package, given its pins in datasheet order: 1, 2, 3, ... N.
 *
 * The numbering runs anticlockwise from pin 1, so the first half goes left to right along the
 * bottom and the second half comes back right to left along the top -- which puts pin N directly
 * above pin 1. Laying that out by hand is the classic way to describe an IC mirrored, and a
 * mirrored IC is wired in backwards without anything looking wrong, so it is computed from the
 * convention instead.
 */
export function dip(specs: readonly PinSpec[], height: number): ManifestPin[] {
  if (specs.length % 2 !== 0) throw new Error(`A DIP has an even pin count, got ${specs.length}`);
  const half = specs.length / 2;

  return specs.map((spec, index) => {
    const bottom = index < half;
    const column = bottom ? index : specs.length - 1 - index;
    return {
      name: spec.name,
      number: index + 1,
      x: PITCH + column * PITCH,
      y: bottom ? height : 0,
      description: spec.description ?? '',
      model: spec.model,
    };
  });
}

/** Width a row of `count` pins needs, plus the margin the canvas keeps around them. */
export const widthFor = (count: number, margin = PITCH): number => (count + 1) * PITCH + margin;


/** An indicator LED built into a part, returning to `cathodePin`. */
export const led = (
  cathodePin: string,
  over: Partial<Extract<PinModel, { kind: 'led' }>> = {},
): PinModel => ({
  kind: 'led',
  cathodePin,
  color: 'red',
  vf: 2,
  ifNominalA: 0.02,
  ifMaxA: 0.03,
  ...over,
});

/** A fixed internal passive between two pins: a coil, a series resistor, a piezo element. */
export const internal = (toPin: string, over: { ohms?: number; farads?: number }): PinModel => ({
  kind: 'passive',
  toPin,
  ...over,
});

/**
 * One register of a peripheral's register file.
 *
 * `fromState` is what makes a simulated sensor return a value the user chose rather than a
 * constant: the register reads back the state variable scaled by `scale`, which is exactly how a
 * datasheet expresses its output ("16384 LSB per g").
 */
export const reg = (address: number, name: string, over: Partial<Register> = {}): Register => ({
  address,
  name,
  reset: 0,
  access: 'rw',
  scale: 1,
  offset: 0,
  bytes: 1,
  ...over,
});

/** An I2C peripheral. Address is the 7-bit one, as every datasheet and scanner sketch reports it. */
export const i2c = (
  address: number,
  registers: readonly Register[],
  sdaPin = 'SDA',
  sclPin = 'SCL',
): Behavior => ({ kind: 'i2c-peripheral', address, sdaPin, sclPin, registers: [...registers] });

/** An SPI peripheral, with the conventions nearly every part follows already filled in. */
export const spi = (
  over: Partial<Extract<Behavior, { kind: 'spi-peripheral' }>> &
    Pick<Extract<Behavior, { kind: 'spi-peripheral' }>, 'mosiPin' | 'misoPin' | 'sckPin' | 'csPin'>,
): Behavior => ({
  kind: 'spi-peripheral',
  mode: 0,
  csActiveLow: true,
  bitOrder: 'msbFirst',
  addressing: 'register',
  readBitPosition: 7,
  readBitValue: 1,
  autoIncrement: true,
  registers: [],
  ...over,
});

/**
 * A breakout board with one header along its edge.
 *
 * The width comes from the pin count rather than from the datasheet's mechanical drawing, because
 * a body narrower than its own header draws pins hanging off the end of the part.
 */
export const headerModule = (
  pinCount: number,
  heightMm: number,
  bodyColor = '#1e3a5f',
): ComponentManifest['package'] => ({
  type: 'module',
  widthMm: widthFor(pinCount),
  heightMm,
  pinPitchMm: PITCH,
  bodyColor,
});

/** Built-in provenance, with the assumptions a datasheet cannot settle written down. */
export const builtin = (unresolved: string[] = []): ComponentManifest['provenance'] => ({
  source: 'builtin',
  unresolved,
  verified: true,
});
