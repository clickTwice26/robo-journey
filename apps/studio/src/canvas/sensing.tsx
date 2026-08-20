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
 * ## The cones are the real ones
 *
 * A rangefinder sees about fifteen degrees, a PIR about a hundred and ten, a flame sensor sixty.
 * Those figures come off the datasheets into the manifest, the field maths refuses any source
 * outside them, and the wedge drawn here is the same number -- so turning a sensor away from a
 * flame stops it detecting the flame, and the picture says why.
 *
 * Zero degrees points up the workspace, which is the way a module's sensing face looks when its
 * header is along the bottom -- the orientation every one of them is drawn in.
 */
import { Circle, Group, Line, Text, Wedge } from 'react-konva';
import {
  CM_PER_CANVAS_MM,
  contributionAt,
  environmentSources,
  partDefinition,
  reachFraction,
  reaches,
  withinView,
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

interface Cone {
  readonly partId: string;
  readonly at: { x: number; y: number };
  readonly facingDeg: number;
  readonly quantity: Quantity;
  /** Detection range in canvas millimetres, or null for a sensor with no stated range. */
  readonly rangeMm: number | null;
  /** Cone width, or null for one that detects in every direction. */
  readonly fieldOfViewDeg: number | null;
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
  selection: string | null,
): { links: Link[]; sensors: ActiveSensor[]; cones: Cone[] } {
  const sources: EnvironmentSource[] = environmentSources(project);
  const links: Link[] = [];
  const sensors: ActiveSensor[] = [];
  const cones: Cone[] = [];

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
      // A source the sensor cannot see gets no line, for the same reason it gets no reading.
      const variable = variables.find((v) => v.quantity === source.quantity)!;
      const inView = withinView(source, {
        ...at,
        facingDeg: part.rotation,
        ...(variable.fieldOfViewDeg !== undefined ? { fieldOfViewDeg: variable.fieldOfViewDeg } : {}),
        ...(variable.rangeCm !== undefined ? { rangeMm: variable.rangeCm / CM_PER_CANVAS_MM } : {}),
      });
      if (!inView) continue;
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

    // What this part can see, drawn when you are looking at it or when it is picking something up.
    // Both, because they answer different questions: "which way is this pointing" is asked about
    // one part at a time, and "what is this one reacting to" is asked while it runs. Drawing every
    // sensor's cone at once would bury the circuit under overlapping wedges.
    if (selection === part.id || mine.length > 0) {
      for (const variable of variables) {
        if (variable.rangeCm === undefined && variable.fieldOfViewDeg === undefined) continue;
        cones.push({
          partId: part.id,
          at,
          facingDeg: part.rotation,
          quantity: variable.quantity!,
          rangeMm: variable.rangeCm === undefined ? null : variable.rangeCm / CM_PER_CANVAS_MM,
          fieldOfViewDeg: variable.fieldOfViewDeg ?? null,
        });
      }
    }

    // Marked only when something is actually reaching it. Keying this off "a source of that kind
    // exists somewhere" would put a halo and a reading on a probe that is picking up nothing --
    // which is precisely the confusion the overlay is here to remove.
    if (mine.length > 0 && readings.length > 0) {
      sensors.push({ partId: part.id, at, quantities, readings });
    }
  }

  return { links, sensors, cones };
}

/**
 * The area a sensor covers.
 *
 * A wedge when the part has a stated cone, a full circle when it detects in every direction. The
 * radius is the declared range at the workspace's own scale -- one millimetre to the centimetre --
 * so a four-metre rangefinder really does cover four hundred millimetres of canvas. That is a lot
 * of workspace, and it is the truth about what the part can reach.
 */
/**
 * How far a cone is drawn before it stops being useful, canvas millimetres.
 *
 * A PIR reaches seven metres, which at this workspace's scale is three and a half thousand pixels
 * of tinted wedge across everything else on the bench. Drawn in full it is truthful and unusable,
 * so beyond this the wedge is cut off and the real figure is written at the edge instead -- the
 * number is still exact, it is just in words rather than in pixels.
 */
const MAX_DRAWN_REACH_MM = 90;

/** A range in the unit that reads best, remembering that a canvas millimetre is a centimetre. */
function formatRange(rangeMm: number): string {
  const cm = rangeMm * CM_PER_CANVAS_MM;
  return cm >= 100 ? `${(cm / 100).toFixed(1)} m` : `${cm.toFixed(0)} cm`;
}

function SensingCone({ cone }: { readonly cone: Cone }) {
  const color = QUANTITY_COLORS[cone.quantity];
  // No stated range still gets a shape, sized to say "this way" rather than "this far".
  const trueReach = cone.rangeMm ?? 45;
  const clipped = trueReach > MAX_DRAWN_REACH_MM;
  const radius = mm(Math.min(trueReach, MAX_DRAWN_REACH_MM));
  const spread = cone.fieldOfViewDeg ?? 360;
  // Konva measures from the positive x axis and this model measures from "up", so the wedge is
  // swung back a quarter turn and then half its own width to centre it on the facing.
  const rotation = cone.facingDeg - 90 - spread / 2;

  return (
    <Group x={mm(cone.at.x)} y={mm(cone.at.y)} listening={false}>
      <Wedge radius={radius} angle={spread} rotation={rotation} fill={color} opacity={0.07} />
      <Wedge
        radius={radius}
        angle={spread}
        rotation={rotation}
        stroke={color}
        strokeWidth={1}
        // A cut-off cone gets a fainter, longer-dashed edge, so it reads as "continues" rather
        // than as a boundary that is not there.
        opacity={clipped ? 0.28 : 0.45}
        dash={clipped ? [3, 7] : [5, 5]}
      />

      {/* Which way is forward, drawn short so it reads even when the wedge runs off screen. */}
      <Line
        points={[0, 0, 0, -mm(9)]}
        stroke={color}
        strokeWidth={1.6}
        opacity={0.85}
        rotation={cone.facingDeg}
      />

      {cone.rangeMm !== null && (
        <Group rotation={cone.facingDeg}>
          <Text
            x={-60}
            y={-radius - (clipped ? 14 : 12)}
            width={120}
            align="center"
            text={clipped ? `${formatRange(trueReach)} →` : formatRange(trueReach)}
            fontSize={6.5}
            fontStyle="bold"
            fill={color}
            opacity={0.85}
            // Counter-rotated so the label stays upright whichever way the part is turned.
            rotation={-cone.facingDeg}
          />
        </Group>
      )}
    </Group>
  );
}

export function SensingLayer({
  project,
  driven,
  selection,
}: {
  readonly project: Project;
  readonly driven: Record<string, Record<string, number>>;
  readonly selection: string | null;
}) {
  const { links, sensors, cones } = couple(project, driven, selection);
  if (links.length === 0 && sensors.length === 0 && cones.length === 0) return null;

  return (
    <Group listening={false}>
      {cones.map((cone) => (
        <SensingCone key={`${cone.partId}:${cone.quantity}`} cone={cone} />
      ))}

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
