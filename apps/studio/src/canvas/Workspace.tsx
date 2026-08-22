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
import { boundsOf, boxOf } from './arrange.ts';
import {
  allHoles,
  nearestHole,
  snapToPitch,
  terminalPositions,
  type Point,
} from './geometry.ts';
import { AmmeterShape, MultimeterShape, OscilloscopeShape } from './instruments.tsx';
import { STIMULUS_SHAPES } from './stimulus.tsx';
import { AnimatedPart, isAnimated } from './animated.tsx';
import { SensingLayer } from './sensing.tsx';
import {
  BreadboardShape,
  ButtonShape,
  GenericPartShape,
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

/** Which way each arrow key goes, in whole holes. */
const NUDGES: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

export function Workspace({ width, height, onControls, onPartContextMenu }: Props & {
  /** Hands zoom controls back to the hosting panel, which renders them over the canvas. */
  onControls?: (controls: CanvasControls) => void;
  /** Right-click on a part, in page coordinates, so the panel can open a DOM menu there. */
  onPartContextMenu?: (event: { partId: string; x: number; y: number }) => void;
}) {
  const project = useStudio((s) => s.project);
  const snapshot = useStudio((s) => s.snapshot);
  const agentFocus = useStudio((s) => s.agentFocus);
  const selectedIds = useStudio((s) => s.selectedIds);
  const mode = useStudio((s) => s.mode);
  const {
    addPart,
    movePart,
    movePartWithAttached,
    addWire,
    removeWire,
    setSelection,
    toggleSelected,
    setMode,
  } = useStudio.getState();

  /** Membership is asked once per part per frame, so it wants to be a set rather than a scan. */
  const chosen = useMemo(() => new Set(selectedIds), [selectedIds]);

  const [view, setView] = useState({ x: 40, y: 30, scale: 1 });
  const [hoverTerminal, setHoverTerminal] = useState<string | null>(null);
  /**
   * The rubber band, in millimetres, while one is being dragged.
   *
   * Held here rather than in the store: it exists for the length of a drag and nothing outside the
   * canvas has any use for it.
   */
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );
  /**
   * How far the part under the cursor has been dragged, while several are selected.
   *
   * The others are drawn at this offset so the whole group moves together under the hand. Without
   * it a group drag looks like one part leaving the others behind, and only snaps together on drop.
   */
  const [groupDrag, setGroupDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  /**
   * Space held. Panning has to move somewhere once dragging empty canvas means selecting, and this
   * is the binding every canvas tool uses for it.
   */
  const [panning, setPanning] = useState(false);
  /**
   * Set when a band has just been resolved, and cleared by the click that follows it.
   *
   * A drag on the canvas still ends in a click, and the click handler's job is to clear the
   * selection -- so without this the band selects six parts and the click immediately unselects
   * them, about a millisecond later and far too fast to see. A ref rather than state because
   * nothing renders from it and it has to be readable in the same tick it is written.
   */
  const bandJustEnded = useRef(false);
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
    // A click that is really the end of a rubber band must not undo what the band just did.
    if (bandJustEnded.current) {
      bandJustEnded.current = false;
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
   * The canvas's own keys.
   *
   * Bound on the window rather than the stage: Konva's canvas is not focusable, so a stage-level
   * key handler would never fire. Guarded against firing while a text field has focus, or typing
   * a resistance would delete the resistor.
   */
  useEffect(() => {
    const typingNow = () => {
      const active = document.activeElement;
      return (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable) ||
        (active instanceof HTMLElement && active.closest('.monaco-editor') !== null)
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (typingNow()) return;
      const store = useStudio.getState();

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (store.selectedIds.length === 0) return;
        event.preventDefault();
        store.removeSelection();
        return;
      }

      // Escape backs out of whatever is half-done, innermost first: a wire being drawn, then a
      // part waiting to be placed, then the selection. One key, one step back, every time.
      if (event.key === 'Escape') {
        if (store.mode.kind !== 'select') store.setMode({ kind: 'select' });
        else store.setSelection(null);
        setMarquee(null);
        return;
      }

      if (event.code === 'Space' && !panning) {
        // No preventDefault on the keydown alone -- Space is also "press the focused button", and
        // taking it outright would break the toolbar for anyone using the keyboard.
        setPanning(true);
        return;
      }

      const step = NUDGES[event.key];
      if (step) {
        // With something selected the arrows move it; with nothing selected they move the view,
        // which is what they do in every map and every canvas.
        const far = event.shiftKey ? 10 : 1;
        event.preventDefault();
        if (store.selectedIds.length > 0) {
          store.nudgeSelection(step.x * PITCH_MM * far, step.y * PITCH_MM * far);
        } else {
          setView((v) => ({ ...v, x: v.x - step.x * 40 * far, y: v.y - step.y * 40 * far }));
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setPanning(false);
    };
    // Losing the window with space held would otherwise leave the canvas stuck in pan mode.
    const onBlur = () => setPanning(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [panning]);

  // Publish the controls once they are stable, so the panel can render buttons over the stage.
  useEffect(() => {
    onControls?.({
      fit: fitToContent,
      zoomIn: () => zoomBy(1.3),
      zoomOut: () => zoomBy(1 / 1.3),
    });
  }, [onControls, fitToContent, zoomBy]);

  const primary = selectedIds[selectedIds.length - 1] ?? null;

  /**
   * Begin a rubber band, if the press landed on nothing.
   *
   * `e.target === stage` is the test for "nothing": Konva reports the topmost shape under the
   * pointer, so a press on a part, a pin or a wire is that shape and never the stage itself.
   */
  const handleStageMouseDown = useCallback(
    (event: Konva.KonvaEventObject<MouseEvent>) => {
      if (panning || mode.kind !== 'select') return;
      if (event.target !== stageRef.current) return;
      const point = pointerMm();
      if (!point) return;
      setMarquee({ x0: point.x, y0: point.y, x1: point.x, y1: point.y });
    },
    [panning, mode.kind, pointerMm],
  );

  const handleStageMouseMove = useCallback(() => {
    if (!marquee) return;
    const point = pointerMm();
    if (!point) return;
    setMarquee((band) => (band ? { ...band, x1: point.x, y1: point.y } : null));
  }, [marquee, pointerMm]);

  /**
   * Finish the band: everything it touches becomes the selection.
   *
   * *Touches*, not *contains*. Having to enclose a part completely means the breadboard under a
   * row of components swallows the band and nothing gets caught, which is exactly when you most
   * want to sweep a few parts up.
   */
  const handleStageMouseUp = useCallback(
    (event: Konva.KonvaEventObject<MouseEvent>) => {
      if (!marquee) return;
      setMarquee(null);

      // The far corner comes from where the pointer is *now*, not from the last move event. A
      // press and release with nothing in between -- a fast flick, or a synthetic drag -- would
      // otherwise leave the band the zero-size rectangle it started as.
      const end = pointerMm();
      const x1 = end?.x ?? marquee.x1;
      const y1 = end?.y ?? marquee.y1;

      const left = Math.min(marquee.x0, x1);
      const right = Math.max(marquee.x0, x1);
      const top = Math.min(marquee.y0, y1);
      const bottom = Math.max(marquee.y0, y1);

      // A band smaller than a hole is a click that wobbled, and clearing the selection is what a
      // click on empty canvas already does.
      if (right - left < PITCH_MM / 2 && bottom - top < PITCH_MM / 2) return;
      bandJustEnded.current = true;

      const caught = project.parts
        .filter((part) => {
          const box = boxOf(part);
          return (
            box.x <= right && box.x + box.width >= left &&
            box.y <= bottom && box.y + box.height >= top
          );
        })
        .map((part) => part.id);

      // Shift adds to what is already selected, so a second sweep can pick up a part the first
      // one missed without starting over.
      const additive = event.evt.shiftKey || event.evt.metaKey || event.evt.ctrlKey;
      setSelection(additive ? [...new Set([...selectedIds, ...caught])] : caught);
    },
    [marquee, project.parts, selectedIds, setSelection, pointerMm],
  );

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
      // Dragging empty canvas draws a selection band, so panning moves to space-drag -- the same
      // trade every canvas tool makes, and the reason the cursor changes while space is down.
      draggable={panning}
      onWheel={handleWheel}
      onClick={handleStageClick}
      onMouseDown={handleStageMouseDown}
      onMouseMove={handleStageMouseMove}
      onMouseUp={handleStageMouseUp}
      onMouseLeave={handleStageMouseUp}
      onDragEnd={(e) => {
        // Only the stage itself pans; a part drag is handled by the part.
        if (e.target === stageRef.current) {
          setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
        }
      }}
      style={{
        background: palette.background,
        cursor: panning ? 'grab' : mode.kind === 'place' ? 'copy' : 'default',
      }}
    >
      {/* Static artwork. Redrawn only when the project changes. */}
      <Layer>
        <GridDots width={width} height={height} view={view} />
        {/* Under the parts, so a coupling line runs behind the things it connects rather than
            across their faces. */}
        <SensingLayer project={project} driven={snapshot.driven} selection={primary} />
        {project.parts.map((part) => {
          const selected = chosen.has(part.id);
          // Every other selected part follows the one being dragged, so the group moves as a group
          // rather than one part breaking away and the rest catching up on the drop.
          const following = groupDrag !== null && selected && groupDrag.id !== part.id;
          const followX = following ? groupDrag.dx : 0;
          const followY = following ? groupDrag.dy : 0;
          const common = { part, selected };
          const draggable = true;
          const definition = (() => {
            try {
              return partDefinition(part.type);
            } catch {
              return null;
            }
          })();

          const StimulusShape = STIMULUS_SHAPES[part.type];

          const shape =
            // The world, not the circuit: a lamp draws as a lamp, with no body and no pins.
            StimulusShape ? <StimulusShape {...common} /> :
            definition?.internalSpec ? (
              <BreadboardShape {...common} spec={definition.internalSpec} />
            ) :
            part.type === 'arduino-uno' ? (
              <UnoShape {...common} showLabels={view.scale >= LABEL_ZOOM_THRESHOLD} />
            ) :
            part.type === 'resistor' ? <ResistorShape {...common} /> :
            part.type === 'led' ? <LedShape {...common} brightness={snapshot.brightness[part.id] ?? 0} /> :
            part.type === 'pushbutton' ? <ButtonShape {...common} /> :
            // Instruments carry a live face rather than a silkscreen: the reading belongs on the
            // meter, next to the probes you ran to take it.
            part.type === 'multimeter' ? (
              <MultimeterShape {...common} readout={snapshot.readouts[part.id]} />
            ) :
            part.type === 'ammeter' ? (
              <AmmeterShape {...common} readout={snapshot.readouts[part.id]} />
            ) :
            part.type === 'oscilloscope' ? (
              <OscilloscopeShape {...common} frame={snapshot.scopes[part.id]} />
            ) :
            // Anything else -- every component extracted from a datasheet -- gets a generic body.
            // Falling through to null here is what made generated parts invisible, leaving only
            // their pin hit-targets on the canvas.
            definition ? (
              // Parts that visibly do something wrap the ordinary artwork rather than replacing
              // it, so a vibration motor is the same drawing, shaking.
              isAnimated(part.type) ? (
                <AnimatedPart part={part} definition={definition} snapshot={snapshot}>
                  <GenericPartShape
                    {...common}
                    definition={definition}
                    showLabels={view.scale >= LABEL_ZOOM_THRESHOLD}
                  />
                </AnimatedPart>
              ) : (
                <GenericPartShape
                  {...common}
                  definition={definition}
                  showLabels={view.scale >= LABEL_ZOOM_THRESHOLD}
                />
              )
            ) : null;

          if (!shape) return null;

          return (
            <Group
              key={part.id}
              draggable={draggable}
              // Positioned by its middle and offset back by half itself, which is how Konva is
              // told to turn a shape about its centre. `terminalPositions` uses the same centre,
              // and the two agreeing is what keeps a wire attached to a leg after a part is
              // turned. The drag handler undoes the half-offset to get the corner back.
              x={mm(part.x + followX) + mm(definition?.width ?? 0) / 2}
              y={mm(part.y + followY) + mm(definition?.height ?? 0) / 2}
              offsetX={mm(definition?.width ?? 0) / 2}
              offsetY={mm(definition?.height ?? 0) / 2}
              rotation={part.rotation}
              onClick={(e) => {
                e.cancelBubble = true;
                // Shift or the platform modifier adds and removes; a plain click replaces. Without
                // the plain-click reset, picking one part out of six selected would silently leave
                // the other five along for the next drag.
                if (e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey) toggleSelected(part.id);
                else setSelection(part.id);
              }}
              onContextMenu={(e) => {
                e.evt.preventDefault();
                e.cancelBubble = true;
                // A right-click inside a multi-selection keeps it, so the menu can act on all of
                // them; outside one, it selects what was clicked, as a left-click would.
                if (!chosen.has(part.id)) setSelection(part.id);
                onPartContextMenu?.({
                  partId: part.id,
                  x: e.evt.clientX,
                  y: e.evt.clientY,
                });
              }}
              onDragStart={() => {
                // Dragging an unselected part selects it first, so what moves is always what is
                // highlighted. Dragging one *of* a selection keeps the selection and moves it all.
                if (!chosen.has(part.id)) setSelection(part.id);
              }}
              onDragMove={(e) => {
                if (!chosen.has(part.id) || selectedIds.length < 2) return;
                // Report the offset so the rest of the group can be drawn following along. Only
                // the dragged part is moved by Konva; the others are rendered at this offset until
                // the drop, when they are all committed at once.
                setGroupDrag({
                  id: part.id,
                  dx: e.target.x() / PX_PER_MM - (definition?.width ?? 0) / 2 - part.x,
                  dy: e.target.y() / PX_PER_MM - (definition?.height ?? 0) / 2 - part.y,
                });
              }}
              onDragEnd={(e) => {
                setGroupDrag(null);
                // The group's position is its centre, so the corner -- which is what the project
                // stores -- is half a part back from it.
                const x = e.target.x() / PX_PER_MM - (definition?.width ?? 0) / 2;
                const y = e.target.y() / PX_PER_MM - (definition?.height ?? 0) / 2;

                if (chosen.has(part.id) && selectedIds.length > 1) {
                  // One history entry for the whole group, and no hole-detection: a part landing
                  // in a hole should be a deliberate placement, not a side effect of sliding six
                  // parts across a board on the way somewhere else.
                  useStudio
                    .getState()
                    .nudgeSelection(snapToPitch(x) - part.x, snapToPitch(y) - part.y);
                  return;
                }
                handleDragEnd(part.id, x, y);
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
        <AgentFocusRing project={project} focus={agentFocus} />
        {hoverTerminal && <TerminalTooltip terminal={hoverTerminal} terminals={terminals} snapshot={snapshot} />}

        {/* A frame around everything selected, so a group reads as one thing to move rather than
            several things that happen to be outlined. Only for more than one -- around a single
            part it would be a second box a millimetre outside the first. */}
        {selectedIds.length > 1 && !marquee && (
          <SelectionFrame project={project} ids={selectedIds} offset={groupDrag} />
        )}

        {marquee && (
          <Rect
            x={mm(Math.min(marquee.x0, marquee.x1))}
            y={mm(Math.min(marquee.y0, marquee.y1))}
            width={mm(Math.abs(marquee.x1 - marquee.x0))}
            height={mm(Math.abs(marquee.y1 - marquee.y0))}
            fill={palette.selection}
            opacity={0.12}
            stroke={palette.selection}
            strokeWidth={1}
            // Scale-invariant, so the band stays a hairline when zoomed right in rather than
            // becoming a thick slab that hides what it is selecting.
            strokeScaleEnabled={false}
            dash={[4, 3]}
            listening={false}
          />
        )}
      </Layer>
    </Stage>
  );
}

/** A wire's colour, tinted toward its measured voltage once the simulation is running. */
/**
 * What colour to draw a wire.
 *
 * `base` is typed as required and the schema defaults it, but a project object built in code --
 * an example, a fixture, anything that skips `parseProject` -- can arrive without one, and an
 * undefined stroke makes Konva draw nothing at all. A wire that is silently invisible reads as a
 * connection that was never made, which is a bad way to lose half an hour.
 */
function wireColor(base: string | undefined, voltage: number | undefined): string {
  if (voltage === undefined) return base || palette.wireDefault;
  if (voltage > 3) return '#ff6b5a';
  if (voltage < 1.5) return '#4a5568';
  return '#f5a524';
}

/** A wire is a line between two points; if either end is unknown there is nothing to draw. */

function PendingWire({ from }: { from: Point }) {
  return (
    <Circle x={mm(from.x)} y={mm(from.y)} radius={4} stroke={palette.selection} strokeWidth={1.5} />
  );
}

/** Probe readout: hovering a terminal shows what a multimeter would read there. */
/**
 * One frame around everything selected.
 *
 * Drawn from the parts' own boxes rather than by grouping them in Konva: they are separate nodes
 * on the layer, and grouping them for the sake of a rectangle would change how every one of them
 * is positioned and turned.
 */
function SelectionFrame({
  project,
  ids,
  offset,
}: {
  readonly project: Project;
  readonly ids: readonly string[];
  readonly offset: { id: string; dx: number; dy: number } | null;
}) {
  const chosen = new Set(ids);
  const boxes = project.parts.filter((p) => chosen.has(p.id)).map(boxOf);
  if (boxes.length < 2) return null;

  const bounds = boundsOf(boxes);
  // Follows a group drag, so the frame stays around its contents rather than being left behind.
  const dx = offset?.dx ?? 0;
  const dy = offset?.dy ?? 0;
  const pad = 1.5;

  return (
    <Rect
      x={mm(bounds.x + dx - pad)}
      y={mm(bounds.y + dy - pad)}
      width={mm(bounds.width + pad * 2)}
      height={mm(bounds.height + pad * 2)}
      stroke={palette.selection}
      strokeWidth={1}
      strokeScaleEnabled={false}
      dash={[6, 4]}
      opacity={0.7}
      cornerRadius={3}
      listening={false}
    />
  );
}

/**
 * A ring round the part the agent is changing.
 *
 * On its own layer above the artwork rather than baked into each shape, because it has to work for
 * every part -- a breadboard, an instrument, a stimulus -- without each of them knowing about the
 * agent. It pulses so it reads as "happening now" rather than as a second kind of selection.
 */
function AgentFocusRing({ project, focus }: { project: Project; focus: string | null }) {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (!focus) return;
    let raf = 0;
    const loop = (now: number) => {
      setPhase(now / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [focus]);

  if (!focus) return null;
  const part = project.parts.find((p) => p.id === focus);
  if (!part) return null;

  let definition;
  try {
    definition = partDefinition(part.type);
  } catch {
    return null;
  }

  const pulse = 0.5 + 0.5 * Math.sin(phase * 5);
  const pad = 4 + pulse * 4;

  return (
    <Group listening={false}>
      <Rect
        x={mm(part.x) - pad}
        y={mm(part.y) - pad}
        width={mm(definition.width) + pad * 2}
        height={mm(definition.height) + pad * 2}
        cornerRadius={5}
        stroke={palette.selection}
        strokeWidth={2}
        opacity={0.35 + pulse * 0.5}
      />
    </Group>
  );
}

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
