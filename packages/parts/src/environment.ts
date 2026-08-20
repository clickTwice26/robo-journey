/**
 * The world around the circuit.
 *
 * A sensor with nothing to sense senses nothing, and until now the only way to tell a simulated
 * photoresistor that a lamp had been switched on was to type a number into a box. That works, and
 * it teaches nothing about the thing that actually makes sensors hard: they respond to a field,
 * and the field depends on where everything is.
 *
 * So stimuli are objects you place. A lamp, a flame, a magnet, something moving, something in the
 * way -- each sits at a point on the workspace and radiates. Sensors read whatever reaches them,
 * which falls off with distance in the shape that quantity actually falls off in: light and sound
 * by the inverse square, a magnet's dipole faster still. Drag the flame closer and the sensor
 * responds, for the same reason it would on a bench.
 *
 * ## The manual value still matters
 *
 * Every source combines with whatever the part's own control is set to, rather than replacing it.
 * The slider is the ambient level -- the light already in the room, the noise floor, the
 * temperature of the air -- and sources add to it, or dominate it, according to what the quantity
 * is. With no sources placed, the sliders behave exactly as they did before.
 *
 * ## Distance
 *
 * One canvas millimetre stands for one centimetre of world. A rangefinder that reaches four metres
 * would otherwise need four metres of workspace, and a lamp that had to be a real room away to be
 * dim would be off screen. The compression is uniform, deliberate, and stated here rather than
 * buried in a constant: everything spatial in this file is in the same stretched units, so the
 * relationships between them stay true even though the absolute scale does not.
 */

/** A physical quantity a sensor can respond to and a stimulus can emit. */
export type Quantity =
  | 'light'
  | 'sound'
  | 'temperature'
  | 'flame'
  | 'motion'
  | 'magnet'
  | 'distance'
  | 'gas'
  | 'moisture'
  | 'vibration';

/** Canvas millimetres per centimetre of modelled world. See the note above. */
export const CM_PER_CANVAS_MM = 1;

/**
 * How a quantity combines and how it thins with distance.
 *
 * `add` sums contributions on top of the ambient value: more lamps, more light. `max` takes the
 * strongest, which is right for the yes/no quantities -- two magnets near a hall sensor do not
 * make it twice as switched. `sound` sums acoustic power and returns decibels. `nearest` is not a
 * field at all: it is the distance to the closest object, which is what a rangefinder measures.
 */
interface QuantityModel {
  readonly combine: 'add' | 'max' | 'sound' | 'nearest';
  /**
   * Shape of the falloff.
   *
   * `square` is the inverse-square law every radiated quantity obeys. `cube` is a magnetic
   * dipole, which is why a magnet has to be almost touching. `flat` does not thin at all inside
   * its reach and is nothing outside it, which is how a motion detector's cone behaves.
   */
  readonly falloff: 'square' | 'cube' | 'flat' | 'none';
}

const MODELS: Record<Quantity, QuantityModel> = {
  light: { combine: 'add', falloff: 'square' },
  sound: { combine: 'sound', falloff: 'square' },
  temperature: { combine: 'add', falloff: 'square' },
  flame: { combine: 'max', falloff: 'square' },
  motion: { combine: 'max', falloff: 'flat' },
  magnet: { combine: 'max', falloff: 'cube' },
  distance: { combine: 'nearest', falloff: 'none' },
  gas: { combine: 'add', falloff: 'square' },
  moisture: { combine: 'max', falloff: 'flat' },
  // Vibration travels through whatever the parts are sitting on rather than through the air, so it
  // falls off gently and reaches everything on the same bench.
  vibration: { combine: 'max', falloff: 'square' },
};

/**
 * One stimulus, placed.
 *
 * `reachMm` is the half-value distance rather than a hard edge: at exactly that far away a
 * radiated quantity has fallen to half its strength, and it keeps falling beyond. Quoting the
 * half-distance is what makes two sources comparable -- a hard cut-off would make a strong source
 * and a wide one look the same.
 */
export interface EnvironmentSource {
  readonly id: string;
  readonly quantity: Quantity;
  /** Position on the workspace, canvas millimetres. */
  readonly x: number;
  readonly y: number;
  /** Strength at the source itself, in the quantity's own unit. */
  readonly intensity: number;
  readonly reachMm: number;
  /** Switched off sources stay on the canvas and stop radiating, as a lamp does. */
  readonly active: boolean;
}

/** Distance between two points on the workspace, canvas millimetres. */
const distanceMm = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(ax - bx, ay - by);

/** How much of a source reaches a point. */
function attenuate(source: EnvironmentSource, distance: number, falloff: QuantityModel['falloff']): number {
  const reach = Math.max(source.reachMm, 0.001);
  switch (falloff) {
    case 'square':
      // Half strength at the reach, inverse-square beyond it. The +1 keeps it finite at zero
      // distance, where a true inverse square would divide by nothing.
      return source.intensity / (1 + (distance / reach) ** 2);
    case 'cube':
      return source.intensity / (1 + (distance / reach) ** 3);
    case 'flat':
      return distance <= reach ? source.intensity : 0;
    case 'none':
      return source.intensity;
  }
}

/**
 * What a sensor at this point reads.
 *
 * `ambient` is the part's own control -- the value it would have with no stimulus placed -- and it
 * is the floor rather than a starting guess. Returns it unchanged when nothing of that quantity
 * exists on the workspace, which is what keeps every existing slider working exactly as it did.
 */
export function fieldAt(
  sources: readonly EnvironmentSource[],
  quantity: Quantity,
  x: number,
  y: number,
  ambient: number,
): number {
  const model = MODELS[quantity];
  const relevant = sources.filter((s) => s.quantity === quantity && s.active);
  if (relevant.length === 0) return ambient;

  switch (model.combine) {
    case 'add': {
      let total = ambient;
      for (const source of relevant) {
        total += attenuate(source, distanceMm(x, y, source.x, source.y), model.falloff);
      }
      return total;
    }

    case 'max': {
      let best = ambient;
      for (const source of relevant) {
        best = Math.max(best, attenuate(source, distanceMm(x, y, source.x, source.y), model.falloff));
      }
      return best;
    }

    case 'sound': {
      // Decibels do not add; the pressures behind them do. Two 60 dB sources make 63 dB, not 120,
      // and anyone who has stood next to two of anything knows which of those is true.
      let power = 10 ** (ambient / 10);
      for (const source of relevant) {
        const distance = distanceMm(x, y, source.x, source.y);
        // Sound loses 6 dB per doubling of distance, which is the inverse-square law written for
        // pressure levels rather than for intensity.
        const level = source.intensity - 20 * Math.log10(1 + distance / Math.max(source.reachMm, 0.001));
        power += 10 ** (level / 10);
      }
      return 10 * Math.log10(power);
    }

    case 'nearest': {
      // Not a field: the distance to the closest object, which is what the sensor is measuring.
      let closest = Infinity;
      for (const source of relevant) {
        closest = Math.min(closest, distanceMm(x, y, source.x, source.y));
      }
      return Number.isFinite(closest) ? closest * CM_PER_CANVAS_MM : ambient;
    }
  }
}

/** True when at least one active source of this quantity exists, so the UI can say who is driving. */
export function isDriven(sources: readonly EnvironmentSource[], quantity: Quantity): boolean {
  return sources.some((s) => s.quantity === quantity && s.active);
}
