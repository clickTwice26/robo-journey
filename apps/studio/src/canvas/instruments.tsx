/**
 * Instrument artwork.
 *
 * These are the only parts on the canvas with a live face rather than a silkscreen, and the face
 * is the point: a meter you have to select and read out of a side panel is a panel with extra
 * steps. The reading is on the instrument, where you are already looking, next to the probes you
 * ran to get it.
 *
 * The screens are drawn from the same snapshot the rest of the overlay uses, so they update at
 * whatever rate the frame loop runs and never reach into the engine themselves.
 */
import { Circle, Group, Line, Rect, Text } from 'react-konva';
import type { PartInstance } from '@robo-journey/parts';
import type { ScopeFrame } from '../sim/protocol.ts';
import type { DeviceReadout } from '@robo-journey/sim-core';
import { canvas } from '../theme.ts';

/** Pixels per millimetre at 100% zoom, matching `shapes.tsx`. */
const PX_PER_MM = 5;
const mm = (value: number): number => value * PX_PER_MM;

/** Segment-LCD colours: the washed-out green every hand-held meter has. */
const LCD_BODY = '#0d1a12';
const LCD_FACE = '#9fba86';
const LCD_TEXT = '#16210f';
const LCD_ALARM = '#8a2f24';

/** Channel colours, in the order a scope numbers its inputs. */
export const CHANNEL_COLORS = ['#f5d442', '#4da3ff', '#f0619a', '#3ecf8e'];

/** Probe lead colours, so a jack reads as the lead you would plug into it. */
const JACK_RED = '#d84a4a';
const JACK_BLACK = '#1a1c20';
const JACK_GREEN = '#3ecf8e';

interface InstrumentProps {
  readonly part: PartInstance;
  readonly selected: boolean;
  readonly readout: readonly DeviceReadout[] | undefined;
}

/** Pull one named row out of a device readout. */
const rowValue = (readout: readonly DeviceReadout[] | undefined, label: string): string | null =>
  readout?.find((r) => r.label === label)?.value ?? null;

const rowAlarm = (readout: readonly DeviceReadout[] | undefined, label: string): boolean =>
  readout?.find((r) => r.label === label)?.alarm === true;

/**
 * A jack: the socket a probe lead plugs into.
 *
 * Drawn as a coloured ring around the terminal the wiring layer already puts there, so the thing
 * you click to start a wire and the thing that looks like a socket are the same thing.
 */
function Jack({ x, y, color, label }: { x: number; y: number; color: string; label: string }) {
  return (
    <Group listening={false}>
      <Circle x={mm(x)} y={mm(y)} radius={6} fill={color} stroke="#00000066" strokeWidth={1.2} />
      <Circle x={mm(x)} y={mm(y)} radius={2.6} fill="#05070a" />
      <Text
        x={mm(x) - 20}
        y={mm(y) - 17}
        width={40}
        align="center"
        text={label}
        fontSize={6.5}
        fontStyle="bold"
        fill="#e7edf5"
      />
    </Group>
  );
}

/** The lit panel a reading is shown on. */
function Lcd({
  x,
  y,
  width,
  height,
  value,
  alarm,
  unitHint,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  value: string;
  alarm: boolean;
  unitHint?: string;
}) {
  return (
    <Group listening={false}>
      <Rect x={x} y={y} width={width} height={height} fill={LCD_BODY} cornerRadius={2} />
      <Rect
        x={x + 2}
        y={y + 2}
        width={width - 4}
        height={height - 4}
        fill={alarm ? LCD_ALARM : LCD_FACE}
        cornerRadius={1.5}
      />
      <Text
        x={x + 4}
        y={y + height / 2 - height * 0.28}
        width={width - 8}
        align="right"
        text={value}
        // Sized off the panel so a long reading like "123.5 mA" never wraps onto a second line.
        fontSize={Math.min(height * 0.56, (width - 8) / (value.length * 0.62))}
        fontStyle="bold"
        fontFamily="monospace"
        fill={alarm ? '#ffe3de' : LCD_TEXT}
        wrap="none"
        listening={false}
      />
      {unitHint && (
        <Text
          x={x + 5}
          y={y + 4}
          text={unitHint}
          fontSize={4.6}
          fontStyle="bold"
          fill={alarm ? '#ffd9d2' : '#3f5230'}
          listening={false}
        />
      )}
    </Group>
  );
}

/** The rotary switch, showing which range the dial is on. */
const DIAL_POSITIONS: { mode: string; mark: string }[] = [
  { mode: 'volts', mark: 'V' },
  { mode: 'amps', mark: 'A' },
  { mode: 'ohms', mark: 'R' },
];

function Dial({ x, y, mode }: { x: number; y: number; mode: string }) {
  const index = Math.max(0, DIAL_POSITIONS.findIndex((p) => p.mode === mode));
  // Eleven, three and seven o'clock: far enough apart to read the position at a glance.
  const angleAt = (i: number) => (-140 + i * 100) * (Math.PI / 180);
  const r = 15;

  return (
    <Group listening={false}>
      <Circle x={x} y={y} radius={r + 3} fill="#12151a" stroke="#00000077" strokeWidth={1.2} />
      <Circle x={x} y={y} radius={r} fill="#333a44" />
      <Circle x={x} y={y} radius={r - 4} fill="#252a32" />
      <Line
        points={[x, y, x + Math.cos(angleAt(index)) * (r - 1), y + Math.sin(angleAt(index)) * (r - 1)]}
        stroke="#f5d442"
        strokeWidth={2.6}
        lineCap="round"
      />
      {DIAL_POSITIONS.map((position, i) => {
        const a = angleAt(i);
        const on = i === index;
        return (
          <Text
            key={position.mode}
            x={x + Math.cos(a) * (r + 9) - 5}
            y={y + Math.sin(a) * (r + 9) - 4}
            width={10}
            align="center"
            text={position.mark}
            fontSize={7}
            fontStyle="bold"
            fill={on ? '#f5d442' : '#69737f'}
          />
        );
      })}
    </Group>
  );
}

/** Digital multimeter: three jacks, a dial and a display. */
export function MultimeterShape({ part, selected, readout }: InstrumentProps) {
  const width = mm(62);
  const height = mm(44);
  const mode = String(part.props.mode ?? 'volts');
  const reading = rowValue(readout, 'Reading') ?? '----';
  const alarm = rowAlarm(readout, 'Reading');

  return (
    <Group>
      <Rect
        width={width}
        height={height}
        fill="#c9a227"
        cornerRadius={6}
        stroke={selected ? canvas.selection : '#00000066'}
        strokeWidth={selected ? 2 : 1}
      />
      {/* The dark inner shell every meter has under its rubber holster. */}
      <Rect x={6} y={6} width={width - 12} height={height - 12} fill="#20242b" cornerRadius={4} listening={false} />

      <Lcd
        x={12}
        y={12}
        width={width - 24}
        height={mm(11)}
        value={reading}
        alarm={alarm}
        unitHint={mode === 'ohms' ? 'RES' : mode === 'amps' ? `DC ${String(part.props.range ?? 'mA')}` : 'DC V'}
      />

      <Dial x={mm(15)} y={mm(30)} mode={mode} />

      <Text
        x={mm(24)}
        y={mm(25.5)}
        text={mode === 'ohms' ? 'RESISTANCE' : mode === 'amps' ? 'DC CURRENT' : 'DC VOLTAGE'}
        fontSize={8}
        fontStyle="bold"
        fill="#dfe6ef"
        listening={false}
      />
      <Text
        x={mm(24)}
        y={mm(29)}
        text={
          mode === 'ohms'
            ? '3 V test source, 3k'
            : mode === 'amps'
              ? `${String(part.props.range ?? 'mA')} jack`
              : '10 M input'
        }
        fontSize={6}
        fill="#8f98a5"
        listening={false}
      />
      <Text x={mm(24)} y={mm(32.5)} text="DMM" fontSize={5.5} fontStyle="bold" fill="#5b6472" listening={false} />

      <Jack x={14} y={40} color={JACK_RED} label="V/R" />
      <Jack x={31} y={40} color={JACK_BLACK} label="COM" />
      <Jack x={48} y={40} color={JACK_RED} label="A" />
    </Group>
  );
}

/** In-line ammeter: two jacks and a display. */
export function AmmeterShape({ part, selected, readout }: InstrumentProps) {
  const width = mm(34);
  const height = mm(22);
  const reading = rowValue(readout, 'Reading') ?? '----';
  const alarm = rowAlarm(readout, 'Reading');

  return (
    <Group>
      <Rect
        width={width}
        height={height}
        fill="#2b3038"
        cornerRadius={4}
        stroke={selected ? canvas.selection : '#00000066'}
        strokeWidth={selected ? 2 : 1}
      />
      <Lcd
        x={6}
        y={6}
        width={width - 12}
        height={mm(8)}
        value={reading}
        alarm={alarm}
        unitHint={`DC ${String(part.props.range ?? 'mA')}`}
      />
      {/* The current path drawn across the body, so it reads as something you break a circuit
          open to insert rather than something you clip across. */}
      <Line
        points={[mm(8), mm(18), mm(26), mm(18)]}
        stroke="#5b6472"
        strokeWidth={1.5}
        dash={[3, 3]}
        listening={false}
      />
      <Jack x={8} y={18} color={JACK_RED} label="IN" />
      <Jack x={26} y={18} color={JACK_BLACK} label="OUT" />
    </Group>
  );
}

/**
 * Four-channel oscilloscope.
 *
 * The screen is drawn from the decimated trace the worker sends with every snapshot: eight
 * vertical divisions at whatever volts-per-division the part is set to, and the timebase across.
 */
export function OscilloscopeShape({
  part,
  selected,
  frame,
}: {
  readonly part: PartInstance;
  readonly selected: boolean;
  readonly frame: ScopeFrame | undefined;
}) {
  const width = mm(112);
  const height = mm(68);
  const voltsPerDiv = Number(part.props.voltsPerDiv ?? 1) || 1;
  const offsetVolts = Number(part.props.offsetVolts ?? 0);
  const span = frame?.span ?? Number(part.props.span ?? 0.05);

  const screen = { x: mm(6), y: mm(6), w: mm(100), h: mm(44) };
  const divisionsY = 8;
  const divisionsX = 10;
  const midY = screen.y + screen.h / 2;

  /** A sample time to an x coordinate, so the horizontal axis is really time. */
  const window = Math.max((frame?.to ?? span) - (frame?.from ?? 0), 1e-12);
  const toX = (time: number): number =>
    screen.x + ((time - (frame?.from ?? 0)) / window) * screen.w;

  /** Volts to a y coordinate on the screen, clipped to the graticule as a real trace is. */
  const toY = (volts: number): number => {
    const divs = (volts - offsetVolts) / voltsPerDiv;
    const y = midY - divs * (screen.h / divisionsY);
    return Math.max(screen.y, Math.min(screen.y + screen.h, y));
  };

  return (
    <Group>
      <Rect
        width={width}
        height={height}
        fill="#1b1f26"
        cornerRadius={5}
        stroke={selected ? canvas.selection : '#00000066'}
        strokeWidth={selected ? 2 : 1}
      />

      {/* Screen. */}
      <Rect x={screen.x} y={screen.y} width={screen.w} height={screen.h} fill="#050a07" cornerRadius={2} listening={false} />

      {/* Graticule. */}
      {Array.from({ length: divisionsY - 1 }, (_, i) => (
        <Line
          key={`h${i}`}
          points={[screen.x, screen.y + ((i + 1) * screen.h) / divisionsY, screen.x + screen.w, screen.y + ((i + 1) * screen.h) / divisionsY]}
          stroke={i === divisionsY / 2 - 1 ? '#2d5a3d' : '#16301f'}
          strokeWidth={i === divisionsY / 2 - 1 ? 1 : 0.5}
          listening={false}
        />
      ))}
      {Array.from({ length: divisionsX - 1 }, (_, i) => (
        <Line
          key={`v${i}`}
          points={[screen.x + ((i + 1) * screen.w) / divisionsX, screen.y, screen.x + ((i + 1) * screen.w) / divisionsX, screen.y + screen.h]}
          stroke={i === divisionsX / 2 - 1 ? '#2d5a3d' : '#16301f'}
          strokeWidth={i === divisionsX / 2 - 1 ? 1 : 0.5}
          listening={false}
        />
      ))}

      {/* Traces. A channel with nothing captured draws nothing rather than a flat line at zero,
          because a flat line is a measurement and no capture is not. */}
      {frame?.traces.map((trace, index) => {
        if (trace.values.length < 2) return null;
        const points: number[] = [];
        trace.values.forEach((volts, i) => {
          points.push(toX(trace.times[i] ?? frame.from), toY(volts));
        });
        return (
          <Line
            key={trace.pin}
            points={points}
            stroke={CHANNEL_COLORS[index % CHANNEL_COLORS.length]}
            strokeWidth={1.4}
            listening={false}
          />
        );
      })}

      {/* Legend and timebase. */}
      {(frame?.traces ?? []).map((trace, index) => {
        // A channel with nothing captured shows a dash, not `0.00 V`. Zero is a measurement, and
        // a probe clipped to nothing has not made one.
        const live = trace.values.length > 0;
        return (
          <Text
            key={trace.pin}
            x={screen.x + index * mm(19)}
            y={screen.y + screen.h + 6}
            text={`${trace.pin} ${live ? `${trace.volts.toFixed(2)} V` : '--'}`}
            fontSize={7}
            fontStyle="bold"
            fill={live ? CHANNEL_COLORS[index % CHANNEL_COLORS.length]! : '#4f5866'}
            listening={false}
          />
        );
      })}
      <Text
        x={screen.x}
        y={screen.y + screen.h + 17}
        text={`${formatSpan(span / divisionsX)}/div    ${voltsPerDiv} V/div`}
        fontSize={6.5}
        fill="#9aa4b2"
        listening={false}
      />
      <Text
        x={screen.x + screen.w - mm(30)}
        y={screen.y + screen.h + 17}
        width={mm(30)}
        align="right"
        text="OSCILLOSCOPE"
        fontSize={6.5}
        fontStyle="bold"
        fill="#4f5866"
        listening={false}
      />

      {['CH1', 'CH2', 'CH3', 'CH4'].map((name, index) => (
        <Jack key={name} x={16 + index * 16} y={63} color={CHANNEL_COLORS[index]!} label={name} />
      ))}
      <Jack x={92} y={63} color={JACK_GREEN} label="GND" />
    </Group>
  );
}

/** A time per division, in the unit that reads best. */
function formatSpan(seconds: number): string {
  if (seconds >= 1) return `${seconds.toFixed(2)} s`;
  if (seconds >= 1e-3) return `${(seconds * 1e3).toFixed(1)} ms`;
  return `${(seconds * 1e6).toFixed(0)} us`;
}
