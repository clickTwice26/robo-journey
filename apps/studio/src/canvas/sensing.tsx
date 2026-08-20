/**
 * What each sensor is picking up, drawn.
 *
 * A sensor that is reading something looks exactly like a sensor that is not, which is the problem
 * this solves: a water source twenty millimetres from a soil probe reads "dry", and that is
 * correct -- the probe is outside the water's reach -- but nothing on screen says so, and the
 * obvious conclusion is that the simulator is broken.
 *
 * ## Drawn from the arithmetic, not alongside it
 *
 * Every line here is `contributionAt` from the environment module, the same function the solver's
 * inputs come from. A line means that source is measurably reaching that sensor, its weight is how
 * strongly, and no line means nothing is. It cannot flatter the simulation because it *is* the
 * simulation.
 *
 * ## Why there are no cones
 *
 * Real sensors are directional -- a rangefinder sees a 15 degree wedge, a PIR about 110 -- and
 * drawing those would look far better than this. But the field model is omnidirectional and parts
 * cannot be rotated yet, so every cone would point the same way and the physics would ignore it: a
 * wall placed inside the wedge and a wall placed behind the sensor would read identically. A
 * picture that disagrees with the simulation is worse than no picture, so the cones arrive with
 * rotation, and not before.
 */
import { Circle, Group, Line, Text } from 'react-konva';
import {
  contributionAt,
  environmentSources,
  partDefinition,
  reachFraction,
  reaches,
  type EnvironmentSource,
  type Project,
  type Quantity,
} from '@robo-journey/parts';
import { canvas } from '../theme.ts';

const PX_PER_MM = 5;
const mm = (value: number): number => value * PX_PER_MM;

/**
 * A colour per quantity, so a canvas with a lamp and a flame on it says which link is which.
 *
 * Mid-tones, because these are drawn straight onto the workspace in both themes.
 */
const QUANTITY_COLORS: Record<Quantity, string> = {
  light: '#e6a817',
  sound: '#1c7ed6',
  temperature: '#f76707',
  flame: '#e8590c',
  motion: '#2f9e44',
  magnet: '#e03131',
  distance: '#868e96',
  gas: '#7a5c2e',
  moisture: '#1c7ed6',
  vibration: '#7048e8',
};

/** Centre of a part, which is where a link starts or ends. */
function centreOf(project: Project, partId: string): { x: number; y: number } | null {
  const part = project.parts.find((p) => p.id === partId);
  if (!part) return null;
  try {
    const definition = partDefinition(part.type);
    return { x: part.x + definition.width / 2, y: part.y + definition.height / 2 };
  } catch {
    return { x: part.x, y: part.y };
  }
}

interface Link {
  readonly key: string;
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
  readonly quantity: Quantity;
  /** How much of the source is arriving, 0 to 1. Sets the weight of the line. */
  readonly strength: number;
}

interface ActiveSensor {
  readonly partId: string;
  readonly at: { x: number; y: number };
  readonly quantities: readonly Quantity[];
  /** What the world is currently supplying, ready to draw. */
  readonly readings: readonly string[];
}

/**
 * Work out which sources are reaching which sensors.
 *
 * Cheap enough to do per render: a handful of sources against a handful of sensors is tens of
 * distance calculations, and it avoids a round trip to the worker for something the UI already has
 * every input to compute.
 */
function couple(
  project: Project,
  driven: Record<string, Record<string, number>>,
): { links: Link[]; sensors: ActiveSensor[] } {
  const sources: EnvironmentSource[] = environmentSources(project);
  const links: Link[] = [];
  const sensors: ActiveSensor[] = [];
  if (sources.length === 0) return { links, sensors };

  for (const part of project.parts) {
    let definition;
    try {
      definition = partDefinition(part.type);
    } catch {
      continue;
    }
    const variables = (definition.state ?? []).filter((v) => v.quantity);
    if (variables.length === 0) continue;

    // The sensing point is the part's middle rather than its origin: a module's origin is its
    // top-left corner, and measuring a distance from there puts a wide breakout's reading
    // centimetres out.
    const at = { x: part.x + definition.width / 2, y: part.y + definition.height / 2 };
    const quantities = variables.map((v) => v.quantity!);
    const supplied = driven[part.id];

    const readings = variables
      .filter((v) => supplied?.[v.name] !== undefined)
      .map((v) => {
        const value = supplied![v.name]!;
        const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 1 ? 1 : 2;
        return `${value.toFixed(digits)}${v.unit ? ` ${v.unit}` : ''}`;
      });

    const mine: Link[] = [];

    for (const source of sources) {
      if (!quantities.includes(source.quantity)) continue;
      if (!reaches(source, at.x, at.y)) continue;
      // `distance` sources always "reach" -- an obstacle is measured, not delivered -- so they get
      // a line only when the sensor is genuinely reading them.
      if (source.quantity === 'distance' && readings.length === 0) continue;
      if (contributionAt(source, at.x, at.y) === 0) continue;

      const from = centreOf(project, source.id.split(':')[0]!);
      if (!from) continue;

      mine.push({
        key: `${source.id}->${part.id}`,
        from,
        to: at,
        quantity: source.quantity,
        strength:
          source.quantity === 'distance' ? 1 : reachFraction(source, at.x, at.y),
      });
    }

    links.push(...mine);

    // Marked only when something is actually reaching it. Keying this off "a source of that kind
    // exists somewhere" would put a halo and a reading on a probe that is picking up nothing --
    // which is precisely the confusion the overlay is here to remove.
    if (mine.length > 0 && readings.length > 0) {
      sensors.push({ partId: part.id, at, quantities, readings });
    }
  }

  return { links, sensors };
}

export function SensingLayer({
  project,
  driven,
}: {
  readonly project: Project;
  readonly driven: Record<string, Record<string, number>>;
}) {
  const { links, sensors } = couple(project, driven);
  if (links.length === 0 && sensors.length === 0) return null;

  return (
    <Group listening={false}>
      {links.map((link) => {
        const color = QUANTITY_COLORS[link.quantity];
        return (
          <Line
            key={link.key}
            points={[mm(link.from.x), mm(link.from.y), mm(link.to.x), mm(link.to.y)]}
            stroke={color}
            // Weight carries the strength as well as opacity: a faint thin line at the edge of a
            // source's reach reads as "barely", which is what it is.
            strokeWidth={0.8 + link.strength * 1.8}
            opacity={0.25 + link.strength * 0.5}
            dash={[6, 5]}
          />
        );
      })}

      {sensors.map((sensor) => (
        <Group key={sensor.partId}>
          {/* A halo saying this one is being driven by the world rather than by its own slider. */}
          <Circle
            x={mm(sensor.at.x)}
            y={mm(sensor.at.y)}
            radius={mm(5)}
            stroke={QUANTITY_COLORS[sensor.quantities[0]!]}
            strokeWidth={1.2}
            opacity={0.55}
          />
          <Text
            x={mm(sensor.at.x) - 60}
            y={mm(sensor.at.y) - mm(7)}
            width={120}
            align="center"
            text={sensor.readings.join('  ')}
            fontSize={6.5}
            fontStyle="bold"
            fill={QUANTITY_COLORS[sensor.quantities[0]!]}
          />
        </Group>
      ))}
    </Group>
  );
}
