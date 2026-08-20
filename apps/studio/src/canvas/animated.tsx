/**
 * Parts that visibly do something.
 *
 * A vibration motor that sits perfectly still while it is running is a vibration motor you cannot
 * tell is running, and the same goes for a buzzer, a servo and a motor. None of this is decoration:
 * the movement is driven by the actual voltage across the part or the actual position the servo
 * has been commanded to, so a part that looks like it is working is one that is.
 *
 * Wrapped around the ordinary artwork rather than replacing it, which keeps every part drawing
 * from the same geometry and means adding another animated part is one line in the table below.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Arc, Circle, Group, Line } from 'react-konva';
import type { PartDefinition, PartInstance } from '@robo-journey/parts';
import type { SimSnapshot } from '../sim/protocol.ts';

const PX_PER_MM = 5;
const mm = (value: number): number => value * PX_PER_MM;

/**
 * How a part shows that it is working, and which two terminals decide whether it is.
 *
 * `servo` is the exception: a servo's horn follows the pulse width it was sent, not the voltage
 * across its supply, so it reads the position the device reports instead.
 */
const ANIMATIONS: Record<string, { kind: 'shake' | 'spin' | 'sound' | 'servo'; plus: string; minus: string }> = {
  'vibration-motor': { kind: 'shake', plus: '+', minus: '-' },
  'dc-motor': { kind: 'spin', plus: 'M1', minus: 'M2' },
  'buzzer-active': { kind: 'sound', plus: '+', minus: '-' },
  'buzzer-passive': { kind: 'sound', plus: '+', minus: '-' },
  sg90: { kind: 'servo', plus: 'VCC', minus: 'GND' },
};

export const isAnimated = (type: string): boolean => type in ANIMATIONS;

/** Wall-clock phase, so a running motor keeps moving while the debugger is stopped on a line. */
function usePhase(active: boolean, fps: number): number {
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

/**
 * How hard the part is being driven, 0 to 1.
 *
 * The voltage actually across its two terminals against the rail it expects. A motor on a pin that
 * is browning out moves less, which is true and is the sort of thing that is otherwise invisible.
 */
function driveOf(part: PartInstance, snapshot: SimSnapshot, plus: string, minus: string): number {
  const a = snapshot.voltages[`${part.id}:${plus}`];
  const b = snapshot.voltages[`${part.id}:${minus}`];
  if (a === undefined || b === undefined) return 0;
  const across = Math.abs(a - b);
  // Below a volt nothing real turns over; five volts is full effort.
  return Math.max(0, Math.min(1, (across - 1) / 4));
}

export function AnimatedPart({
  part,
  definition,
  snapshot,
  children,
}: {
  readonly part: PartInstance;
  readonly definition: PartDefinition;
  readonly snapshot: SimSnapshot;
  readonly children: ReactNode;
}) {
  const config = ANIMATIONS[part.type]!;
  const drive = driveOf(part, snapshot, config.plus, config.minus);
  const width = mm(definition.width);
  const height = mm(definition.height);

  // The servo's own report, which is the position it has actually reached rather than the one it
  // was told to go to -- a servo takes time to get there and the horn should show that.
  const positionRow = snapshot.readouts[part.id]?.find((r) => r.label === 'Position');
  const degrees = positionRow ? Number.parseFloat(positionRow.value) : null;

  const active = config.kind === 'servo' ? drive > 0 : drive > 0.05;
  const phase = usePhase(active, config.kind === 'shake' ? 30 : 12);

  if (config.kind === 'shake') {
    // Amplitude follows the drive: a motor on a weak supply buzzes rather than shakes.
    const amplitude = drive * 2.5;
    return (
      <Group
        x={Math.sin(phase * 55) * amplitude}
        y={Math.cos(phase * 71) * amplitude}
        rotation={Math.sin(phase * 47) * drive * 3}
        offsetX={0}
      >
        {children}
      </Group>
    );
  }

  if (config.kind === 'spin') {
    return (
      <Group>
        {children}
        {/* A shaft mark going round, which is the only honest way to show rotation on a still
            body -- the body itself does not move. */}
        <Group x={width / 2} y={height / 2} rotation={active ? (phase * 360 * (0.4 + drive)) % 360 : 0}>
          <Circle radius={mm(3)} stroke="#c9d3e0" strokeWidth={1} opacity={0.8} />
          <Line points={[0, 0, mm(3), 0]} stroke="#f5d442" strokeWidth={2} lineCap="round" />
        </Group>
      </Group>
    );
  }

  if (config.kind === 'sound') {
    const rings = Math.floor(phase * 6) % 3;
    return (
      <Group>
        {children}
        {active &&
          [0, 1, 2].map((i) => (
            <Arc
              key={i}
              x={width / 2}
              y={height / 2}
              innerRadius={mm(4) + i * 5}
              outerRadius={mm(4) + i * 5 + 1.2}
              angle={140}
              rotation={-70}
              fill="#7ec8ff"
              opacity={(i === rings ? 0.9 : 0.3) * drive}
              listening={false}
            />
          ))}
      </Group>
    );
  }

  // Servo: a horn that points where the shaft actually is.
  const angle = degrees === null || Number.isNaN(degrees) ? 0 : degrees;
  return (
    <Group>
      {children}
      <Group x={width * 0.75} y={height / 2} rotation={angle - 90}>
        <Circle radius={mm(1.6)} fill="#c9d3e0" />
        <Line points={[0, 0, mm(5), 0]} stroke="#e9eef5" strokeWidth={2.4} lineCap="round" />
        <Circle x={mm(5)} y={0} radius={1.4} fill="#8f98a5" />
      </Group>
    </Group>
  );
}
