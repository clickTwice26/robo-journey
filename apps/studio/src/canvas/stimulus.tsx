/**
 * The interaction toolkit, drawn.
 *
 * These are the only things on the canvas that are not part of the circuit, so they are drawn to
 * look like it: no body, no pins, no header strip -- just the object itself on the workspace, the
 * way a lamp sits on a bench rather than in a schematic.
 *
 * Selecting one shows the circle it reaches. That is the whole spatial model made visible: half
 * strength at the ring, falling off beyond it, and a sensor inside the ring is a sensor that will
 * notice. Without it the falloff would be invisible and dragging would be guesswork.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Circle, Group, Line, Path, Rect, Text } from 'react-konva';
import { partDefinition, type PartInstance } from '@robo-journey/parts';
import { canvas } from '../theme.ts';

const PX_PER_MM = 5;
const mm = (value: number): number => value * PX_PER_MM;

/** A stimulus type's declared reach, for drawing the ring before anyone has changed it. */
function defaultReach(type: string): number {
  try {
    return Number(partDefinition(type).defaults.reachMm ?? 30);
  } catch {
    return 30;
  }
}

/**
 * A slow clock for things that visibly move.
 *
 * Runs on wall-clock rather than simulated time on purpose: a flame flickers whether or not the
 * sketch is running, and freezing the fire when you pause the program would suggest the pause did
 * something to the world.
 */
function useFlicker(active: boolean, fps = 20): number {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = 0;
    const interval = 1000 / fps;
    const loop = (now: number) => {
      if (now - last >= interval) {
        last = now;
        setPhase(now / 1000);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, fps]);

  return phase;
}

interface StimulusProps {
  readonly part: PartInstance;
  readonly selected: boolean;
}

/**
 * The half-strength ring, drawn only for the selection so the canvas is not full of circles.
 *
 * Its colour is interface chrome rather than part of the object, which is why the caller passes a
 * mid-tone rather than the bright fill the icon uses: the ring is drawn straight onto the
 * workspace and has to be legible whether that ground is dark or light.
 */
function Reach({ part, selected, color }: StimulusProps & { color: string }) {
  // The definition's own default, not a generic one: a sound source reaches 50 mm and a magnet 15,
  // and drawing 30 for both until someone touches the slider would make the ring a lie.
  const fallback = defaultReach(part.type);
  const reach = Number(part.props.reachMm ?? fallback);
  if (!selected || !(reach > 0)) return null;

  const definitionSize = mm(14);
  return (
    <Group listening={false}>
      <Circle
        x={definitionSize / 2}
        y={definitionSize / 2}
        radius={mm(reach)}
        stroke={color}
        strokeWidth={1.2}
        dash={[4, 4]}
        // Mid-tones at half opacity vanish on a light ground; this reads on both.
        opacity={0.75}
      />
      <Text
        x={definitionSize / 2 - 40}
        y={definitionSize / 2 - mm(reach) - 12}
        width={80}
        align="center"
        text={`half at ${reach} mm`}
        fontSize={6}
        fill={color}
        opacity={0.95}
      />
    </Group>
  );
}

/** Shared chrome: the selection ring and the dimming that says a source is switched off. */
function Base({
  part,
  selected,
  color,
  children,
}: StimulusProps & { color: string; children: ReactNode }) {
  const on = part.props.on !== false;
  const size = mm(14);

  return (
    <Group opacity={on ? 1 : 0.35}>
      <Reach part={part} selected={selected} color={color} />
      {selected && (
        <Rect
          x={-3}
          y={-3}
          width={size + 6}
          height={size + 6}
          cornerRadius={4}
          stroke={canvas.selection}
          strokeWidth={1.5}
          listening={false}
        />
      )}
      {/* A hit target, so the whole icon can be clicked and dragged rather than only its strokes. */}
      <Rect width={size} height={size} fill="#00000001" />
      {children}
      {!on && (
        <Line
          points={[2, 2, size - 2, size - 2]}
          stroke="#8f98a5"
          strokeWidth={1.5}
          listening={false}
        />
      )}
    </Group>
  );
}

/** A flame, which flickers because a still flame reads as a picture of one. */
export function FlameShape({ part, selected }: StimulusProps) {
  const on = part.props.on !== false;
  const phase = useFlicker(on);
  // Two out-of-step waves, so the motion never looks like a metronome.
  const wobble = Math.sin(phase * 9) * 0.06 + Math.sin(phase * 14.3) * 0.03;
  const h = mm(14);

  return (
    <Base part={part} selected={selected} color="#e8590c">
      <Group x={h / 2} y={h} scaleY={1 + wobble} scaleX={1 - wobble * 0.5}>
        {/* Outer flame. */}
        <Path
          data="M 0 0 C -14 -8 -10 -22 0 -34 C 10 -22 14 -8 0 0 Z"
          fill="#ff7a3d"
          opacity={0.9}
        />
        {/* Inner cone, the hot part. */}
        <Path data="M 0 -2 C -7 -8 -5 -16 0 -23 C 5 -16 7 -8 0 -2 Z" fill="#ffd257" />
      </Group>
    </Base>
  );
}

/** A lamp. */
export function LampShape({ part, selected }: StimulusProps) {
  const on = part.props.on !== false;
  const c = mm(14) / 2;

  return (
    <Base part={part} selected={selected} color="#e6a817">
      {on &&
        // Rays, drawn as short spokes rather than a glow: a glow on a dark canvas turns into a
        // smudge, and spokes read as "this is emitting" at any zoom.
        Array.from({ length: 8 }, (_, i) => {
          const a = (i * Math.PI) / 4;
          return (
            <Line
              key={i}
              points={[c + Math.cos(a) * 16, c + Math.sin(a) * 16, c + Math.cos(a) * 24, c + Math.sin(a) * 24]}
              stroke="#ffe08a"
              strokeWidth={1.5}
              opacity={0.7}
              listening={false}
            />
          );
        })}
      <Circle x={c} y={c} radius={12} fill={on ? '#ffe08a' : '#5b6472'} />
      <Circle x={c} y={c} radius={7} fill={on ? '#fff6d6' : '#71798a'} />
      <Rect x={c - 5} y={c + 10} width={10} height={5} fill="#8f98a5" cornerRadius={1} />
    </Base>
  );
}

/** A sound source: a speaker with pressure arcs. */
export function SoundShape({ part, selected }: StimulusProps) {
  const on = part.props.on !== false;
  const phase = useFlicker(on, 8);
  const c = mm(14) / 2;
  // The arcs pulse outward, which is the only way a still image says "this is making a noise".
  const step = Math.floor(phase * 4) % 3;

  return (
    <Base part={part} selected={selected} color="#1c7ed6">
      <Rect x={c - 12} y={c - 8} width={8} height={16} fill="#5b6472" cornerRadius={1} />
      <Path data={`M ${c - 4} ${c - 8} L ${c + 4} ${c - 15} L ${c + 4} ${c + 15} L ${c - 4} ${c + 8} Z`} fill="#8f98a5" />
      {on &&
        [0, 1, 2].map((i) => (
          <Path
            key={i}
            data={`M ${c + 8 + i * 6} ${c - 8 - i * 4} Q ${c + 14 + i * 6} ${c} ${c + 8 + i * 6} ${c + 8 + i * 4}`}
            stroke="#7ec8ff"
            strokeWidth={1.6}
            opacity={i === step ? 0.95 : 0.35}
            listening={false}
          />
        ))}
    </Base>
  );
}

/** A heat source with no flame. */
export function HeatShape({ part, selected }: StimulusProps) {
  const on = part.props.on !== false;
  const phase = useFlicker(on, 12);
  const c = mm(14) / 2;

  return (
    <Base part={part} selected={selected} color="#f76707">
      <Circle x={c} y={c + 4} radius={9} fill="#c0563a" />
      <Circle x={c} y={c + 4} radius={5} fill="#ff9d6b" />
      {/* Rising heat: three wavy lines drifting upward. */}
      {[0, 1, 2].map((i) => {
        const drift = on ? ((phase * 8 + i * 3) % 9) : 0;
        return (
          <Path
            key={i}
            data={`M ${c - 8 + i * 8} ${c - 4 - drift} q 3 -4 0 -8`}
            stroke="#ff9d6b"
            strokeWidth={1.4}
            opacity={on ? 0.8 - drift / 14 : 0.3}
            listening={false}
          />
        );
      })}
    </Base>
  );
}

/** Something moving through the scene. */
export function MotionShape({ part, selected }: StimulusProps) {
  const on = part.props.on !== false;
  const phase = useFlicker(on, 12);
  const c = mm(14) / 2;
  const sway = on ? Math.sin(phase * 6) * 3 : 0;

  return (
    <Base part={part} selected={selected} color="#2f9e44">
      <Group x={sway}>
        {/* A walking figure: head, body, two legs mid-stride. */}
        <Circle x={c} y={c - 10} radius={4} fill="#37b24d" />
        <Line points={[c, c - 6, c, c + 3]} stroke="#37b24d" strokeWidth={2.4} lineCap="round" />
        <Line points={[c, c + 3, c - 5, c + 12]} stroke="#37b24d" strokeWidth={2.2} lineCap="round" />
        <Line points={[c, c + 3, c + 5, c + 12]} stroke="#37b24d" strokeWidth={2.2} lineCap="round" />
        <Line points={[c - 5, c - 3, c + 5, c - 1]} stroke="#37b24d" strokeWidth={2} lineCap="round" />
      </Group>
      {on &&
        [0, 1].map((i) => (
          <Line
            key={i}
            points={[c - 14 - i * 4, c - 2, c - 20 - i * 4, c - 2]}
            stroke="#37b24d"
            strokeWidth={1.4}
            opacity={0.5 - i * 0.2}
            listening={false}
          />
        ))}
    </Base>
  );
}

/** A wall: what a rangefinder measures the distance to. */
export function ObstacleShape({ part, selected }: StimulusProps) {
  const size = mm(16);
  return (
    <Base part={part} selected={selected} color="#868e96">
      <Rect width={size} height={size} fill="#4c5665" cornerRadius={2} />
      {/* Brick courses, so it reads as a wall and not as a component body. */}
      {[0, 1, 2].map((r) => (
        <Line
          key={r}
          points={[0, ((r + 1) * size) / 4, size, ((r + 1) * size) / 4]}
          stroke="#39414e"
          strokeWidth={1}
          listening={false}
        />
      ))}
      {[0, 1, 2, 3].map((r) => (
        <Line
          key={`v${r}`}
          points={[r % 2 === 0 ? size / 2 : size / 4, (r * size) / 4, r % 2 === 0 ? size / 2 : size / 4, ((r + 1) * size) / 4]}
          stroke="#39414e"
          strokeWidth={1}
          listening={false}
        />
      ))}
    </Base>
  );
}

/** A horseshoe magnet, poles marked because half the sensors care which one they see. */
export function MagnetShape({ part, selected }: StimulusProps) {
  const c = mm(12) / 2;
  return (
    <Base part={part} selected={selected} color="#e03131">
      <Path
        data={`M ${c - 10} ${c + 10} L ${c - 10} ${c - 2} A 10 10 0 0 1 ${c + 10} ${c - 2} L ${c + 10} ${c + 10} L ${c + 4} ${c + 10} L ${c + 4} ${c - 2} A 4 4 0 0 0 ${c - 4} ${c - 2} L ${c - 4} ${c + 10} Z`}
        fill="#8f98a5"
      />
      <Rect x={c - 10} y={c + 10} width={6} height={4} fill="#d84a4a" />
      <Rect x={c + 4} y={c + 10} width={6} height={4} fill="#3f6fd8" />
    </Base>
  );
}

/** Water, for the soil probe. */
export function WaterShape({ part, selected }: StimulusProps) {
  const c = mm(14) / 2;
  return (
    <Base part={part} selected={selected} color="#1c7ed6">
      <Path
        data={`M ${c} ${c - 12} C ${c + 10} ${c - 2} ${c + 8} ${c + 10} ${c} ${c + 10} C ${c - 8} ${c + 10} ${c - 10} ${c - 2} ${c} ${c - 12} Z`}
        fill="#3f8fd8"
      />
      <Path data={`M ${c - 3} ${c + 2} q 3 4 6 0`} stroke="#bfe0ff" strokeWidth={1.4} />
    </Base>
  );
}

/** A shaker: the knock that sets a vibration sensor off. */
export function ShakerShape({ part, selected }: StimulusProps) {
  const on = part.props.on !== false;
  const phase = useFlicker(on, 24);
  const c = mm(14) / 2;
  const jitter = on ? Math.sin(phase * 40) * 2.5 : 0;

  return (
    <Base part={part} selected={selected} color="#7048e8">
      <Group x={jitter}>
        <Rect x={c - 7} y={c - 7} width={14} height={14} fill="#8a5fb0" cornerRadius={2} />
        <Circle x={c} y={c} radius={3} fill="#e0b0ff" />
      </Group>
      {on &&
        [1, 2].map((i) => (
          <Group key={i} listening={false}>
            <Line points={[c - 10 - i * 4, c - 5, c - 10 - i * 4, c + 5]} stroke="#e0b0ff" strokeWidth={1.4} opacity={0.6 / i} />
            <Line points={[c + 10 + i * 4, c - 5, c + 10 + i * 4, c + 5]} stroke="#e0b0ff" strokeWidth={1.4} opacity={0.6 / i} />
          </Group>
        ))}
    </Base>
  );
}

/** Every stimulus shape, by part type. */
export const STIMULUS_SHAPES: Record<string, (props: StimulusProps) => ReactElement> = {
  'stim-flame': FlameShape,
  'stim-lamp': LampShape,
  'stim-sound': SoundShape,
  'stim-heat': HeatShape,
  'stim-motion': MotionShape,
  'stim-obstacle': ObstacleShape,
  'stim-magnet': MagnetShape,
  'stim-water': WaterShape,
  'stim-shaker': ShakerShape,
};
