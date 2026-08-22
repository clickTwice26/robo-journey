/**
 * Part artwork.
 *
 * Drawn from the same millimetre geometry the simulator uses, so what you see is where the pins
 * actually are. Every shape draws at its own origin -- the workspace wraps it in a positioned,
 * draggable Group -- so dragging is one transform rather than a coordinate negotiation. Konva's layer model keeps the static artwork on one layer and the live overlay
 * (lit LEDs, wire colours, probe readouts) on another, so a repaint at 60 Hz does not redraw the
 * breadboard's four hundred holes.
 */
import { Circle, Group, Line, Rect, Text } from 'react-konva';
import {
  ALL_ROWS,
  HALF_SIZE_BREADBOARD,
  boardRows,
  channelBounds,
  railOffset,
  rowOffset,
  type BreadboardSpec,
} from '@robo-journey/sim-core';
import {
  PITCH_MM,
  partDefinition,
  type PartDefinition,
  type PartInstance,
} from '@robo-journey/parts';
import { bandHeightOf, bodyLayout, fitText, rowKey } from './part-layout.ts';
import { canvas } from '../theme.ts';

/** Pixels per millimetre at 100% zoom. */
export const PX_PER_MM = 5;

const mm = (value: number): number => value * PX_PER_MM;

interface ShapeProps {
  readonly part: PartInstance;
  readonly selected: boolean;
}

/**
 * Zoom at which silkscreen text becomes legible rather than noise.
 *
 * Below this the labels are smaller than the sockets they name and just muddy the board, so they
 * are not drawn at all -- hovering a pin names it at any zoom.
 */
export const LABEL_ZOOM_THRESHOLD = 1.1;

// ---------------------------------------------------------------------------------------------

export function BreadboardShape({
  part,
  selected,
  spec = HALF_SIZE_BREADBOARD,
}: ShapeProps & { spec?: BreadboardSpec }) {
  const width = mm((spec.columns + 2) * PITCH_MM);
  const height = mm(boardRows(spec) * PITCH_MM);
  const channel = channelBounds(spec);

  // Every hole is drawn from the same offsets the netlist uses, so a leg that looks like it is in
  // a hole really is in that hole.
  const holes: React.ReactElement[] = [];
  for (let column = 1; column <= spec.columns; column++) {
    for (const row of ALL_ROWS) {
      holes.push(
        <Rect
          key={`${column}${row}`}
          x={mm(column * PITCH_MM) - 1.6}
          y={mm(rowOffset(spec, row) * PITCH_MM) - 1.6}
          width={3.2}
          height={3.2}
          fill={canvas.breadboardHole}
          cornerRadius={0.6}
          listening={false}
        />,
      );
    }
  }

  const rails: React.ReactElement[] = [];
  const railLines: React.ReactElement[] = [];
  if (spec.powerRails) {
    for (const side of ['top', 'bottom'] as const) {
      for (const polarity of ['positive', 'negative'] as const) {
        const offset = railOffset(spec, side, polarity);
        if (offset === null) continue;

        railLines.push(
          <Line
            key={`line-${side}-${polarity}`}
            points={[
              mm(PITCH_MM),
              mm((offset + (polarity === 'positive' ? -0.45 : 0.45)) * PITCH_MM),
              width - mm(PITCH_MM),
              mm((offset + (polarity === 'positive' ? -0.45 : 0.45)) * PITCH_MM),
            ]}
            stroke={polarity === 'positive' ? canvas.railPositive : canvas.railNegative}
            strokeWidth={1}
            listening={false}
          />,
        );

        for (let column = 1; column <= spec.columns; column++) {
          // Rail holes come in groups of five on a real board; the gaps are cosmetic but they are
          // what makes a breadboard legible at a glance.
          if (column % 6 === 0) continue;
          rails.push(
            <Rect
              key={`${side}${polarity}${column}`}
              x={mm(column * PITCH_MM) - 1.6}
              y={mm(offset * PITCH_MM) - 1.6}
              width={3.2}
              height={3.2}
              fill={canvas.breadboardHole}
              cornerRadius={0.6}
              listening={false}
            />,
          );
        }
      }
    }
  }

  return (
    <Group>
      <Rect
        width={width}
        height={height}
        fill={canvas.breadboardBody}
        cornerRadius={3}
        stroke={selected ? canvas.selection : '#c9c6bf'}
        strokeWidth={selected ? 2 : 1}
      />
      {/* Centre channel: the single most important feature of a breadboard. */}
      <Rect
        x={0}
        y={mm(channel.top * PITCH_MM)}
        width={width}
        height={mm(channel.height * PITCH_MM)}
        fill={canvas.breadboardChannel}
        listening={false}
      />
      {railLines}
      {/* The mid-rail break, which is why half a circuit sometimes goes dead. */}
      {spec.powerRails && spec.railSegments > 1 && (
        <Rect
          x={mm((spec.columns / 2 + 0.5) * PITCH_MM) - 2}
          y={0}
          width={4}
          height={height}
          fill={canvas.breadboardBody}
          listening={false}
        />
      )}
      {rails}
      {holes}
      {/* Column numbers every five, as printed. */}
      {Array.from({ length: Math.floor(spec.columns / 5) }, (_, i) => (i + 1) * 5).map((column) => (
        <Text
          key={column}
          x={mm(column * PITCH_MM) - 6}
          y={mm((rowOffset(spec, 'A') - 0.85) * PITCH_MM)}
          width={12}
          align="center"
          text={String(column)}
          fontSize={5}
          fill="#6f6c66"
          listening={false}
        />
      ))}
    </Group>
  );
}

// ---------------------------------------------------------------------------------------------

export function UnoShape({ part, selected, showLabels = false }: ShapeProps & { showLabels?: boolean }) {
  const definition = partDefinition('arduino-uno');
  const width = mm(definition.width);
  const height = mm(definition.height);

  // Header shrouds are drawn to span the pins they actually contain, computed from the pin list
  // rather than hard-coded, so moving a pin can never leave it outside its connector.
  const shroud = (names: readonly string[]) => {
    const pins = definition.pins.filter((pin) => names.includes(pin.name));
    if (pins.length === 0) return null;
    const xs = pins.map((pin) => pin.x);
    return {
      x: mm(Math.min(...xs) - 1.6),
      y: mm(pins[0]!.y - 1.6),
      width: mm(Math.max(...xs) - Math.min(...xs) + 3.2),
      height: mm(3.2),
    };
  };

  const shrouds = [
    shroud(['AREF', 'GND3', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8']),
    shroud(['D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0']),
    shroud(['IOREF', 'RESET', '3V3', '5V', 'GND', 'GND2', 'VIN']),
    shroud(['A0', 'A1', 'A2', 'A3', 'A4', 'A5']),
  ].filter((box) => box !== null);

  return (
    <Group>
      <Rect
        width={width}
        height={height}
        fill={canvas.boardBody}
        cornerRadius={4}
        stroke={selected ? canvas.selection : '#0a5b66'}
        strokeWidth={selected ? 2 : 1}
      />

      {/* USB jack and barrel jack, so the board reads as an Uno at a glance. */}
      <Rect x={mm(-1)} y={mm(6)} width={mm(12)} height={mm(11)} fill="#b9bcc2" cornerRadius={1} />
      <Rect x={mm(-1)} y={mm(36)} width={mm(10)} height={mm(9)} fill="#1a1c20" cornerRadius={1} />
      {/* The DIP microcontroller. */}
      <Rect x={mm(24)} y={mm(30)} width={mm(35)} height={mm(9)} fill="#15181d" cornerRadius={1} />
      <Text x={mm(27)} y={mm(33)} text="ATmega328P" fontSize={4.5} fill="#7d848e" listening={false} />

      <Text x={mm(13)} y={mm(20)} text="ARDUINO  UNO" fontSize={7} fontStyle="bold" fill="#d8f2f5" listening={false} />
      <Text x={mm(13)} y={mm(25)} text="robo-journey" fontSize={4.5} fill="#8fd4dd" listening={false} />

      {/* Black plastic header shrouds. */}
      {shrouds.map((box, i) => (
        <Rect key={i} {...box} fill={canvas.boardHeader} cornerRadius={1} />
      ))}

      {/* One socket per pin, drawn from the same list the simulator wires up. */}
      {definition.pins.map((pin) => {
        const top = pin.y < definition.height / 2;
        return (
          <Group key={pin.name}>
            <Rect
              x={mm(pin.x) - 2.4}
              y={mm(pin.y) - 2.4}
              width={4.8}
              height={4.8}
              fill="#0a0c0f"
              cornerRadius={0.8}
              listening={false}
            />
            <Circle x={mm(pin.x)} y={mm(pin.y)} radius={1.5} fill={canvas.pinBrass} listening={false} />
            {/* Silkscreen, rotated to run along the pin as it does on the real board. */}
            {showLabels && (
              <Text
                x={mm(pin.x) + 2.2}
                y={mm(pin.y) + (top ? 4.5 : -4.5)}
                text={pin.label ?? pin.name}
                fontSize={6}
                fontStyle="bold"
                fill="#f2ffff"
                rotation={top ? 90 : -90}
                listening={false}
              />
            )}
          </Group>
        );
      })}
    </Group>
  );
}

// ---------------------------------------------------------------------------------------------

const LED_COLORS: Record<string, { body: string; glow: string; visible?: boolean }> = {
  // `visible: false` is not a rendering shortcut: an infrared LED conducting at 20 mA emits
  // nothing a person can see, and drawing it glowing would be the simulator telling a lie about
  // the one thing you would use it to find out.
  infrared: { body: '#3a2a2a', glow: '#5a3a3a', visible: false },
  red: { body: '#c0392b', glow: '#ff6b5a' },
  orange: { body: '#c26618', glow: '#ffa94d' },
  yellow: { body: '#c8a71f', glow: '#ffe066' },
  green: { body: '#2f9e44', glow: '#69db7c' },
  blue: { body: '#1c60c4', glow: '#74c0fc' },
  white: { body: '#c9ccd1', glow: '#ffffff' },
  uv: { body: '#5b3ea8', glow: '#b197fc', visible: false },
};

export function LedShape({
  part,
  selected,
  brightness = 0,
}: ShapeProps & { brightness?: number }) {
  const color = LED_COLORS[String(part.props.color ?? 'red')] ?? LED_COLORS.red!;
  const radius = mm(2.5);
  // An invisible emitter still passes current and still gets hot; it simply does not light up.
  const lit = brightness > 0.02 && color.visible !== false;

  return (
    <Group>
      {/* Legs: anode long, cathode short, one pitch apart -- as on the real part. */}
      <Line points={[0, 0, 0, mm(3)]} stroke={canvas.pinBrass} strokeWidth={1.5} />
      <Line points={[mm(PITCH_MM), 0, mm(PITCH_MM), mm(2)]} stroke={canvas.pinBrass} strokeWidth={1.5} />
      {lit && (
        <Circle
          x={mm(PITCH_MM / 2)}
          y={mm(-2)}
          radius={radius * (1.8 + brightness * 1.6)}
          fill={color.glow}
          opacity={0.13 + brightness * 0.4}
          listening={false}
        />
      )}
      <Circle
        x={mm(PITCH_MM / 2)}
        y={mm(-2)}
        radius={radius}
        fill={lit ? color.glow : color.body}
        opacity={lit ? 0.55 + brightness * 0.45 : 0.85}
        stroke={selected ? canvas.selection : '#00000055'}
        strokeWidth={selected ? 2 : 0.5}
      />
    </Group>
  );
}

// ---------------------------------------------------------------------------------------------

/** Resistor colour bands, so a 220R visibly reads red-red-brown. */
const BAND_COLORS = [
  '#000000', '#8b4513', '#c0392b', '#e67e22', '#f1c40f',
  '#2f9e44', '#1c60c4', '#8e44ad', '#7f8c8d', '#ecf0f1',
];

function bandsFor(ohms: number): string[] {
  if (!(ohms > 0)) return ['#7f8c8d', '#7f8c8d', '#7f8c8d'];
  const exponent = Math.max(0, Math.floor(Math.log10(ohms)) - 1);
  const significant = Math.round(ohms / 10 ** exponent);
  const first = Math.floor(significant / 10) % 10;
  const second = significant % 10;
  return [
    BAND_COLORS[first] ?? '#7f8c8d',
    BAND_COLORS[second] ?? '#7f8c8d',
    BAND_COLORS[Math.min(9, exponent)] ?? '#7f8c8d',
  ];
}

export function ResistorShape({ part, selected }: ShapeProps) {
  const span = mm(4 * PITCH_MM);
  const bodyStart = mm(PITCH_MM * 0.8);
  const bodyWidth = span - bodyStart * 2;
  const bands = bandsFor(Number(part.props.ohms ?? 220));

  return (
    <Group>
      <Line points={[0, 0, span, 0]} stroke={canvas.pinBrass} strokeWidth={1.5} />
      <Rect
        x={bodyStart}
        y={-mm(1.1)}
        width={bodyWidth}
        height={mm(2.2)}
        fill="#d9c9a3"
        cornerRadius={2}
        stroke={selected ? canvas.selection : '#00000044'}
        strokeWidth={selected ? 2 : 0.5}
      />
      {bands.map((color, i) => (
        <Rect
          key={i}
          x={bodyStart + bodyWidth * (0.18 + i * 0.2)}
          y={-mm(1.1)}
          width={2.2}
          height={mm(2.2)}
          fill={color}
          listening={false}
        />
      ))}
    </Group>
  );
}

// ---------------------------------------------------------------------------------------------

export function ButtonShape({ part, selected }: ShapeProps) {
  const size = mm(2 * PITCH_MM);
  const pressed = part.props.pressed === true;
  // The four legs, at the corners of a 0.2" square. Read off the definition rather than written
  // out here, so the artwork cannot drift from what the simulator wires up -- this shape drew no
  // legs at all, which made a tactile switch the one part on the canvas you could not see how to
  // wire.
  const pins = (() => {
    try {
      return partDefinition(part.type).pins;
    } catch {
      return [];
    }
  })();

  return (
    <Group>
      <Rect
        x={-mm(1)}
        y={-mm(1)}
        width={size + mm(2)}
        height={size + mm(2)}
        fill="#22262d"
        cornerRadius={1}
        stroke={selected ? canvas.selection : '#00000044'}
        strokeWidth={selected ? 2 : 0.5}
      />

      {/* Under the cap, so a leg reads as coming out from beneath the body. */}
      {pins.map((pin) => (
        <Group key={pin.name} listening={false}>
          <Rect
            x={mm(pin.x) - 2.4}
            y={mm(pin.y) - 2.4}
            width={4.8}
            height={4.8}
            fill="#0a0c0f"
            cornerRadius={0.8}
          />
          <Circle x={mm(pin.x)} y={mm(pin.y)} radius={1.5} fill={canvas.pinBrass} />
        </Group>
      ))}

      <Circle
        x={size / 2}
        y={size / 2}
        radius={mm(1.6)}
        fill={pressed ? '#8c2f2f' : '#c0392b'}
      />
    </Group>
  );
}

// ---------------------------------------------------------------------------------------------

/**
 * Generic body for a part with no bespoke artwork.
 *
 * Every component extracted from a datasheet lands here. Without it such a part draws as nothing
 * and only its pin hit-targets appear on the canvas, which reads as a broken component rather than
 * a working one the renderer has never seen.
 *
 * Deliberately schematic rather than photographic: a body, real pin positions, and the part number.
 * Pretending to know what an unfamiliar package looks like would be a worse lie than drawing a
 * labelled rectangle.
 */
export function GenericPartShape({
  part,
  selected,
  definition,
  showLabels = false,
}: ShapeProps & { definition: PartDefinition; showLabels?: boolean }) {
  const width = mm(definition.width);
  const height = mm(definition.height);
  const appearance = definition.appearance;
  const body = appearance?.bodyColor ?? '#2b3038';

  const title = appearance?.title ?? definition.label;
  const subtitle = appearance?.subtitle;
  const hasSubtitle = Boolean(subtitle);

  // Sized to the body rather than to a fixed scale, because a name that does not fit does not
  // simply look cramped -- Konva wraps it, and the second line lands on whatever is below. An
  // AMS1117-3.3 on a SOT-223 is seven millimetres wide and its own part number is eleven
  // characters, so this is the common case and not the edge one.
  const titleSize = fitText(title, width - 6, Math.min(9, Math.max(5, width / 7)));
  const subtitleSize = subtitle
    ? fitText(subtitle, width - 6, Math.min(6, Math.max(4, width / 11)))
    : 0;
  const textHeight = titleSize + (hasSubtitle ? subtitleSize + 2 : 0);

  const layout = bodyLayout(definition, textHeight / PX_PER_MM);
  const band = layout.titleBand;
  // Centred in the gap the pins left, and only drawn when the gap can hold it: a name half off the
  // body is worse than no name.
  const textTop = band ? mm(band.top) + Math.max(0, (mm(bandHeightOf(band)) - textHeight) / 2) : 0;

  /** The header strip a pin row sits on, so a row of pins reads as a connector. */
  const pinYs = definition.pins.map((pin) => pin.y);
  const headerTop = mm(Math.min(...pinYs)) - 3;
  const headerHeight = mm(Math.max(...pinYs) - Math.min(...pinYs)) + 6;

  return (
    <Group>
      <Rect
        width={width}
        height={height}
        fill={body}
        cornerRadius={2}
        stroke={selected ? canvas.selection : '#00000066'}
        strokeWidth={selected ? 2 : 1}
      />

      <Rect y={headerTop} width={width} height={headerHeight} fill="#00000026" listening={false} />

      {/* A pin-1 marker, the way every IC package carries one. */}
      <Circle x={mm(1.4)} y={mm(1.4)} radius={1.6} fill="#ffffff33" listening={false} />

      {band && (
        <Text
          x={3}
          y={textTop}
          width={width - 6}
          align="center"
          text={title}
          fontSize={titleSize}
          fontStyle="bold"
          fill="#e9eef5"
          wrap="none"
          ellipsis
          listening={false}
        />
      )}
      {band && hasSubtitle && (
        <Text
          x={3}
          y={textTop + titleSize + 2}
          width={width - 6}
          align="center"
          text={subtitle!}
          fontSize={subtitleSize}
          fill="#9aa4b2"
          wrap="none"
          ellipsis
          listening={false}
        />
      )}

      {/* Generated parts are marked on the canvas, not only in the palette -- the distinction
          matters most when you are looking at the circuit and wondering whether to trust it. */}
      {appearance?.generated && (
        <Text
          x={width - 12}
          y={3}
          text="AI"
          fontSize={5}
          fontStyle="bold"
          fill={canvas.selection}
          listening={false}
        />
      )}

      {/* Pins, drawn where the manifest actually puts them. */}
      {definition.pins.map((pin) => {
        const up = layout.labelUp.get(rowKey(pin)) ?? false;
        return (
          <Group key={pin.name}>
            <Rect
              x={mm(pin.x) - 2.2}
              y={mm(pin.y) - 2.2}
              width={4.4}
              height={4.4}
              fill="#0a0c0f"
              cornerRadius={0.8}
              listening={false}
            />
            <Circle x={mm(pin.x)} y={mm(pin.y)} radius={1.4} fill={canvas.pinBrass} listening={false} />
            {showLabels && layout.labelsFit && (
              // Konva runs text away from the anchor along the rotated axis, so -90 reads upward
              // and puts the glyph column on the opposite side of the anchor. That is why the
              // horizontal nudge flips with the direction.
              <Text
                x={mm(pin.x) + (up ? -2.2 : 2.2)}
                y={mm(pin.y) + (up ? -3.4 : 3.4)}
                text={pin.name}
                fontSize={5}
                fontStyle="bold"
                fill="#f2ffff"
                rotation={up ? -90 : 90}
                listening={false}
              />
            )}
          </Group>
        );
      })}
    </Group>
  );
}
