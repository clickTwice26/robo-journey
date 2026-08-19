/**
 * The workspace canvas.
 *
 * Pan, zoom, place, drag and wire. Parts snap to the 0.1" pitch and legs snap into breadboard
 * holes, which is what makes "plugging something in" mean the same thing here as on a desk: the
 * snap creates a real connection in the netlist, not a visual alignment.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva';
import type Konva from 'konva';
import {
  PITCH_MM,
  partDefinition,
  partsPluggedInto,
  terminalId,
  type Project,
} from '@robo-journey/parts';
import { canvas as palette } from '../theme.ts';
import { nextId, useStudio } from '../store.ts';
import {
  allHoles,
  nearestHole,
  snapToPitch,
  terminalPositions,
  type Point,
} from './geometry.ts';
import {
  BreadboardShape,
  ButtonShape,
  LABEL_ZOOM_THRESHOLD,
  LedShape,
  PX_PER_MM,
  ResistorShape,
  UnoShape,
} from './shapes.tsx';

const mm = (value: number): number => value * PX_PER_MM;

export interface CanvasControls {
  fit(): void;
  zoomIn(): void;
  zoomOut(): void;
}

interface Props {
  readonly width: number;
  readonly height: number;
}

/** Bounding box of every part, in millimetres. Null when the canvas is empty. */
function contentBounds(project: Project): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const part of project.parts) {
    let definition;
    try {
      definition = partDefinition(part.type);
    } catch {
      continue;
    }
    minX = Math.min(minX, part.x);
    minY = Math.min(minY, part.y);
    maxX = Math.max(maxX, part.x + definition.width);
    maxY = Math.max(maxY, part.y + definition.height);
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function Workspace({ width, height, onControls, onPartContextMenu }: Props & {
  /** Hands zoom controls back to the hosting panel, which renders them over the canvas. */
  onControls?: (controls: CanvasControls) => void;
  /** Right-click on a part, in page coordinates, so the panel can open a DOM menu there. */
  onPartContextMenu?: (event: { partId: string; x: number; y: number }) => void;
}) {
  const project = useStudio((s) => s.project);
  const snapshot = useStudio((s) => s.snapshot);
  const selection = useStudio((s) => s.selection);
  const mode = useStudio((s) => s.mode);
  const {
    addPart,
    movePart,
    movePartWithAttached,
    addWire,
    removeWire,
    removePart,
    setSelection,
    setMode,
  } = useStudio.getState();

  const [view, setView] = useState({ x: 40, y: 30, scale: 1 });
  const [hoverTerminal, setHoverTerminal] = useState<string | null>(null);
  const stageRef = useRef<Konva.Stage>(null);

  const terminals = useMemo(() => terminalPositions(project), [project]);
  const holes = useMemo(() => allHoles(project), [project]);

  /** Frame the whole circuit with a small margin. */
  const fitToContent = useCallback(() => {
    const bounds = contentBounds(project);
    if (!bounds || width === 0 || height === 0) return;

    const marginPx = 24;
    const scale = Math.min(
      6,
      Math.max(
        0.15,
        Math.min(
          (width - marginPx * 2) / mm(bounds.w),
          (height - marginPx * 2) / mm(bounds.h),
        ),
      ),
    );
    setView({
      scale,
      x: (width - mm(bounds.w) * scale) / 2 - mm(bounds.x) * scale,
      y: (height - mm(bounds.h) * scale) / 2 - mm(bounds.y) * scale,
    });
  }, [project, width, height]);

  // Frame the circuit the first time there is something to frame, and whenever the panel is
  // resized from nothing. Not on every project change -- re-framing while the user is placing
  // parts would yank the view out from under them.
  const framedRef = useRef(false);
  useEffect(() => {
    if (framedRef.current || project.parts.length === 0 || width === 0) return;
    framedRef.current = true;
    fitToContent();
  }, [project.parts.length, width, fitToContent]);

  /** Pointer position in millimetres, accounting for pan and zoom. */
  const pointerMm = useCallback((): Point | null => {
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return null;
    return {
      x: (pointer.x - view.x) / (PX_PER_MM * view.scale),
      y: (pointer.y - view.y) / (PX_PER_MM * view.scale),
    };
  }, [view]);

  const handleWheel = useCallback((event: Konva.KonvaEventObject<WheelEvent>) => {
    event.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return;

    setView((current) => {
      // Zoom about the cursor, so the thing under the pointer stays under the pointer.
      const next = Math.min(6, Math.max(0.15, current.scale * (event.evt.deltaY > 0 ? 0.92 : 1.08)));
      const ratio = next / current.scale;
      return {
        scale: next,
        x: pointer.x - (pointer.x - current.x) * ratio,
        y: pointer.y - (pointer.y - current.y) * ratio,
      };
    });
  }, []);

  /** Clicking a terminal starts a wire, or finishes the one in progress. */
  const handleTerminalClick = useCallback(
    (terminal: string) => {
      if (mode.kind === 'wire') {
        if (mode.from !== terminal) {
          addWire({ id: nextId('w'), from: mode.from, to: terminal, color: palette.wireDefault });
        }
        setMode({ kind: 'select' });
        return;
      }
      setMode({ kind: 'wire', from: terminal });
    },
    [mode, addWire, setMode],
  );

  /** Clicking empty canvas places a pending part, or clears the selection. */
  const handleStageClick = useCallback(() => {
    if (mode.kind === 'wire') {
      setMode({ kind: 'select' });
      return;
    }
    if (mode.kind === 'place') {
      const point = pointerMm();
      if (!point) return;
      addPart({
        id: nextId(mode.partType.slice(0, 2)),
        type: mode.partType,
        x: snapToPitch(point.x),
        y: snapToPitch(point.y),
        rotation: 0,
        props: {},
      });
      setMode({ kind: 'select' });
      return;
    }
    setSelection(null);
  }, [mode, pointerMm, addPart, setMode, setSelection]);

  /**
   * Finish a drag: snap the part to pitch, then look for holes under its legs.
   *
   * Auto-wiring on drop is what makes the breadboard feel physical. A leg that lands over a hole
   * is in that hole -- the user should not have to draw a wire to say so.
   */
  const handleDragEnd = useCallback(
    (partId: string, rawX: number, rawY: number) => {
      const x = snapToPitch(rawX);
      const y = snapToPitch(rawY);

      const current = useStudio.getState().project;
      const part = current.parts.find((p) => p.id === partId);
      if (!part) return;
      let definition;
      try {
        definition = partDefinition(part.type);
      } catch {
        return;
      }

      if (definition.internalSpec) {
        // Dragging a board takes everything plugged into it along. Anything else means the legs
        // stay behind while the holes move away, which looks like a rendering bug and is really a
        // circuit that has quietly come apart.
        movePartWithAttached(partId, x, y, partsPluggedInto(current, partId));
        return;
      }

      movePart(partId, x, y);

      const existing = new Set(
        useStudio.getState().project.wires.flatMap((w) => [w.from, w.to]),
      );

      for (const pin of definition.pins) {
        const terminal = terminalId(partId, pin.name);
        if (existing.has(terminal)) continue;
        const hole = nearestHole({ x: x + pin.x, y: y + pin.y }, holes);
        if (hole) {
          addWire({ id: nextId('w'), from: terminal, to: hole, color: palette.wireDefault });
        }
      }
    },
    [movePart, addWire, holes],
  );

  /**
   * Zoom about the centre of the viewport.
   *
   * Scaling without moving the origin zooms about the canvas origin instead, which walks the
   * circuit off screen after two or three clicks -- the content you were looking at is exactly
   * what you lose.
   */
  const zoomBy = useCallback(
    (factor: number) => {
      setView((current) => {
        const next = Math.min(6, Math.max(0.15, current.scale * factor));
        const ratio = next / current.scale;
        const cx = width / 2;
        const cy = height / 2;
        return {
          scale: next,
          x: cx - (cx - current.x) * ratio,
          y: cy - (cy - current.y) * ratio,
        };
      });
    },
    [width, height],
  );

  /**
   * Delete or Backspace removes the selection.
   *
   * Bound on the window rather than the stage: Konva's canvas is not focusable, so a stage-level
   * key handler would never fire. Guarded against firing while a text field has focus, or typing
   * a resistance would delete the resistor.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;

      const active = document.activeElement;
      const typing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (typing) return;

      const selected = useStudio.getState().selection;
      if (!selected) return;
      event.preventDefault();
      removePart(selected);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [removePart]);

  // Publish the controls once they are stable, so the panel can render buttons over the stage.
  useEffect(() => {
    onControls?.({
      fit: fitToContent,
      zoomIn: () => zoomBy(1.3),
      zoomOut: () => zoomBy(1 / 1.3),
    });
  }, [onControls, fitToContent, zoomBy]);

  const wireStart = mode.kind === 'wire' ? terminals.get(mode.from) : undefined;

  return (
    <Stage
      ref={stageRef}
      width={width}
      height={height}
      x={view.x}
      y={view.y}
      scaleX={view.scale}
      scaleY={view.scale}
      draggable
      onWheel={handleWheel}
      onClick={handleStageClick}
      onDragEnd={(e) => {
        // Only the stage itself pans; a part drag is handled by the part.
        if (e.target === stageRef.current) {
          setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
        }
      }}
      style={{ background: palette.background }}
    >
      {/* Static artwork. Redrawn only when the project changes. */}
      <Layer>
        <GridDots width={width} height={height} view={view} />
        {project.parts.map((part) => {
          const selected = selection === part.id;
          const common = { part, selected };
          const draggable = true;
          const definition = (() => {
            try {
              return partDefinition(part.type);
            } catch {
              return null;
            }
          })();

          const shape =
            definition?.internalSpec ? (
              <BreadboardShape {...common} spec={definition.internalSpec} />
            ) :
            part.type === 'arduino-uno' ? (
              <UnoShape {...common} showLabels={view.scale >= LABEL_ZOOM_THRESHOLD} />
            ) :
            part.type === 'resistor' ? <ResistorShape {...common} /> :
            part.type === 'led' ? <LedShape {...common} brightness={snapshot.brightness[part.id] ?? 0} /> :
            part.type === 'pushbutton' ? <ButtonShape {...common} /> :
            null;

          if (!shape) return null;

          return (
            <Group
              key={part.id}
              draggable={draggable}
              x={mm(part.x)}
              y={mm(part.y)}
              onClick={(e) => {
                e.cancelBubble = true;
                setSelection(part.id);
              }}
              onContextMenu={(e) => {
                e.evt.preventDefault();
                e.cancelBubble = true;
                setSelection(part.id);
                onPartContextMenu?.({
                  partId: part.id,
                  x: e.evt.clientX,
                  y: e.evt.clientY,
                });
              }}
              onDragEnd={(e) => {
                handleDragEnd(part.id, e.target.x() / PX_PER_MM, e.target.y() / PX_PER_MM);
              }}
            >
              {shape}
            </Group>
          );
        })}
      </Layer>

      {/* Wires and live overlay. */}
      <Layer>
        {project.wires.map((wire) => {
          const from = terminals.get(wire.from);
          const to = terminals.get(wire.to);
          if (!from || !to) return null;
          const voltage = snapshot.voltages[wire.from];
          return (
            <Line
              key={wire.id}
              points={[mm(from.x), mm(from.y), mm(to.x), mm(to.y)]}
              stroke={wireColor(wire.color, voltage)}
              strokeWidth={2}
              lineCap="round"
              opacity={0.95}
              // Generous hit width: a 2 px line is almost impossible to click deliberately.
              hitStrokeWidth={10}
              onContextMenu={(e) => {
                e.evt.preventDefault();
                e.cancelBubble = true;
                removeWire(wire.id);
              }}
            />
          );
        })}
        {wireStart && <PendingWire from={wireStart} />}
      </Layer>

      {/* Interaction targets: every terminal and hole. */}
      <Layer>
        {[...terminals].map(([terminal, point]) => (
          <Circle
            key={terminal}
            x={mm(point.x)}
            y={mm(point.y)}
            radius={3.5}
            fill={hoverTerminal === terminal ? palette.selection : 'transparent'}
            opacity={hoverTerminal === terminal ? 0.85 : 0.01}
            onMouseEnter={() => setHoverTerminal(terminal)}
            onMouseLeave={() => setHoverTerminal((t) => (t === terminal ? null : t))}
            onClick={(e) => {
              e.cancelBubble = true;
              handleTerminalClick(terminal);
            }}
          />
        ))}
        {hoverTerminal && <TerminalTooltip terminal={hoverTerminal} terminals={terminals} snapshot={snapshot} />}
      </Layer>
    </Stage>
  );
}

/** A wire's colour, tinted toward its measured voltage once the simulation is running. */
function wireColor(base: string, voltage: number | undefined): string {
  if (voltage === undefined) return base;
  if (voltage > 3) return '#ff6b5a';
  if (voltage < 1.5) return '#4a5568';
  return '#f5a524';
}

function PendingWire({ from }: { from: Point }) {
  return (
    <Circle x={mm(from.x)} y={mm(from.y)} radius={4} stroke={palette.selection} strokeWidth={1.5} />
  );
}

/** Probe readout: hovering a terminal shows what a multimeter would read there. */
function TerminalTooltip({
  terminal,
  terminals,
  snapshot,
}: {
  terminal: string;
  terminals: ReadonlyMap<string, Point>;
  snapshot: { voltages: Record<string, number> };
}) {
  const point = terminals.get(terminal);
  if (!point) return null;
  const voltage = snapshot.voltages[terminal];
  const label = voltage === undefined ? terminal : `${terminal}  ${voltage.toFixed(2)} V`;

  return (
    <Group x={mm(point.x) + 8} y={mm(point.y) - 16} listening={false}>
      <Rect width={label.length * 5.4 + 10} height={16} fill="#0b0d10" cornerRadius={3} opacity={0.92} />
      <Text x={5} y={4} text={label} fontSize={9} fill="#e6e9ef" />
    </Group>
  );
}

/** Faint pitch grid, so placement reads as being on a 0.1" lattice. */
function GridDots({
  width,
  height,
  view,
}: {
  width: number;
  height: number;
  view: { x: number; y: number; scale: number };
}) {
  // Below a certain zoom the dots become noise, so they simply stop being drawn.
  if (view.scale < 0.6) return null;

  const step = mm(PITCH_MM * 2);
  const startX = Math.floor(-view.x / view.scale / step) * step;
  const startY = Math.floor(-view.y / view.scale / step) * step;
  const cols = Math.ceil(width / view.scale / step) + 2;
  const rows = Math.ceil(height / view.scale / step) + 2;

  const dots: React.ReactElement[] = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      dots.push(
        <Rect
          key={`${i}-${j}`}
          x={startX + i * step}
          y={startY + j * step}
          width={1}
          height={1}
          fill={palette.grid}
          listening={false}
        />,
      );
    }
  }
  return <>{dots}</>;
}
