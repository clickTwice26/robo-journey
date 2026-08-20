/**
 * The interaction toolkit: things you put on the workspace to make sensors do something.
 *
 * These are not components. They have no pins, contribute nothing to the circuit, and cannot be
 * wired to anything -- they are the world. A flame is hot and bright and gives off infrared; a
 * magnet has a field; something moving is something a motion detector notices. Drag one near a
 * sensor and the sensor responds, drag it away and it stops, which is the whole interaction.
 *
 * Every intensity here is the value at the object itself and every reach is the distance at which
 * that has fallen by half. Both are properties you can change, because a candle and a bonfire are
 * the same object with different numbers.
 */
import type { EnvironmentSource, Quantity } from './environment.js';
import type { Project } from './project.js';
import type { PartDefinition } from './registry.js';

/** What a stimulus part emits. Read off the definition rather than matched by part type. */
export interface Emission {
  readonly quantity: Quantity;
  /** Property holding the strength, so the inspector can edit it. */
  readonly intensityProp: string;
  /** Property holding the half-distance. */
  readonly reachProp: string;
}

/** Emissions by part type. A flame emits three things at once, which is why this is a list. */
export const EMISSIONS: Record<string, readonly Emission[]> = {
  'stim-flame': [
    { quantity: 'flame', intensityProp: 'flame', reachProp: 'reachMm' },
    { quantity: 'temperature', intensityProp: 'heatC', reachProp: 'reachMm' },
    { quantity: 'light', intensityProp: 'lux', reachProp: 'reachMm' },
    { quantity: 'gas', intensityProp: 'smokePpm', reachProp: 'reachMm' },
  ],
  'stim-lamp': [{ quantity: 'light', intensityProp: 'lux', reachProp: 'reachMm' }],
  'stim-sound': [{ quantity: 'sound', intensityProp: 'db', reachProp: 'reachMm' }],
  'stim-magnet': [{ quantity: 'magnet', intensityProp: 'strength', reachProp: 'reachMm' }],
  'stim-motion': [
    { quantity: 'motion', intensityProp: 'moving', reachProp: 'reachMm' },
    // Something moving is also something in the way, which is what a rangefinder sees.
    { quantity: 'distance', intensityProp: 'moving', reachProp: 'reachMm' },
  ],
  'stim-obstacle': [{ quantity: 'distance', intensityProp: 'present', reachProp: 'reachMm' }],
  'stim-water': [{ quantity: 'moisture', intensityProp: 'moisture', reachProp: 'reachMm' }],
  'stim-heat': [{ quantity: 'temperature', intensityProp: 'heatC', reachProp: 'reachMm' }],
  'stim-shaker': [{ quantity: 'vibration', intensityProp: 'amplitude', reachProp: 'reachMm' }],
};

/** Common shape: a small square object with no pins, an on/off switch and a reach. */
function stimulus(
  type: string,
  label: string,
  size: number,
  defaults: Record<string, unknown>,
): PartDefinition {
  return {
    type,
    label,
    category: 'stimulus',
    width: size,
    height: size,
    // No pins at all. Nothing here is electrical, and giving these terminals would invite wiring
    // a flame to a resistor.
    pins: [],
    defaults: { on: true, ...defaults },
  };
}

/**
 * A flame.
 *
 * The one the flame sensor is for, and the reason it emits four things: a fire is infrared, heat,
 * light and smoke at once, so putting one next to a gas sensor sets that off too. That is not a
 * flourish -- a circuit that only notices the fire on the sensor you aimed at it is a circuit that
 * has not been tested.
 */
const FLAME = stimulus('stim-flame', 'Flame', 14, {
  flame: 1,
  heatC: 180,
  lux: 900,
  smokePpm: 2500,
  reachMm: 40,
});

const LAMP = stimulus('stim-lamp', 'Lamp', 14, { lux: 800, reachMm: 60 });

const SOUND = stimulus('stim-sound', 'Sound source', 14, { db: 85, reachMm: 50 });

const MAGNET = stimulus('stim-magnet', 'Magnet', 12, { strength: 1, reachMm: 15 });

/** Something moving through the scene: a hand, a person, a passing cat. */
const MOTION = stimulus('stim-motion', 'Moving object', 14, { moving: 1, reachMm: 70 });

/** A wall. What a rangefinder measures the distance to. */
const OBSTACLE = stimulus('stim-obstacle', 'Obstacle', 16, { present: 1, reachMm: 400 });

const WATER = stimulus('stim-water', 'Water', 14, { moisture: 85, reachMm: 20 });

/** A heat source with no flame: a radiator, a hot component, a hand on the sensor. */
const HEAT = stimulus('stim-heat', 'Heat source', 14, { heatC: 45, reachMm: 30 });

/** A shaker: the tap, knock or motor that sets a vibration sensor off. */
const SHAKER = stimulus('stim-shaker', 'Vibration', 14, { amplitude: 1, reachMm: 45 });

/** Default properties per stimulus type, so a project that omits one still radiates something. */
const DEFAULTS: Record<string, Record<string, unknown>> = {};

export const STIMULI: readonly PartDefinition[] = [
  FLAME,
  LAMP,
  SOUND,
  HEAT,
  MOTION,
  OBSTACLE,
  MAGNET,
  WATER,
  SHAKER,
];

for (const definition of STIMULI) DEFAULTS[definition.type] = definition.defaults;

/**
 * Every source a project's stimulus objects amount to.
 *
 * One placed object can be several sources -- a flame is infrared and heat and light and smoke --
 * so this flattens them, which is the form the field maths wants.
 */
export function environmentSources(project: Project): EnvironmentSource[] {
  const sources: EnvironmentSource[] = [];

  for (const part of project.parts) {
    const emissions = EMISSIONS[part.type];
    if (!emissions) continue;
    const definition = DEFAULTS[part.type] ?? {};
    const props = { ...definition, ...part.props };
    const active = props.on !== false;

    for (const emission of emissions) {
      const intensity = Number(props[emission.intensityProp] ?? 0);
      const reachMm = Number(props[emission.reachProp] ?? 30);
      if (!Number.isFinite(intensity) || !Number.isFinite(reachMm)) continue;
      sources.push({
        id: `${part.id}:${emission.quantity}`,
        quantity: emission.quantity,
        x: part.x,
        y: part.y,
        intensity,
        reachMm,
        active,
      });
    }
  }

  return sources;
}

/** Whether a part type is a stimulus rather than a component. */
export const isStimulus = (type: string): boolean => type in EMISSIONS;
