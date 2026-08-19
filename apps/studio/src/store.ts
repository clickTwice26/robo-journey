/**
 * Application state.
 *
 * The project is the single source of truth: parts, wires and sketch. Everything the canvas draws
 * is derived from it, and everything the mouse does is a mutation of it. Simulation results arrive
 * separately as snapshots and are never merged in -- keeping measured values out of the document
 * is what makes save, undo and diff sane.
 */
import { create } from 'zustand';
import { emptyProject, type PartInstance, type Project, type Wire } from '@robo-journey/parts';
import { EMPTY_SNAPSHOT, type SimSnapshot } from './sim/protocol.ts';

export type CompileStatus = 'idle' | 'compiling' | 'ok' | 'error';

export interface Diagnostic {
  file: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
}

/** What the canvas is currently doing, which determines how clicks are interpreted. */
export type CanvasMode = { kind: 'select' } | { kind: 'wire'; from: string } | { kind: 'place'; partType: string };

interface StudioState {
  project: Project;
  snapshot: SimSnapshot;
  selection: string | null;
  mode: CanvasMode;

  compileStatus: CompileStatus;
  diagnostics: Diagnostic[];
  hex: string | null;
  /**
   * A failure of the build system itself, as opposed to the sketch.
   *
   * Kept apart from `diagnostics` because the remedy differs: a diagnostic points at a line of
   * code, this points at the environment. Reporting "Docker is not running" as a marker on line 1
   * of a valid file sends the user hunting through code that is fine.
   */
  buildError: string | null;

  setProject(project: Project): void;
  addPart(part: PartInstance): void;
  movePart(id: string, x: number, y: number): void;
  updatePartProps(id: string, props: Record<string, unknown>): void;
  removePart(id: string): void;

  addWire(wire: Wire): void;
  removeWire(id: string): void;

  setSketch(name: string, contents: string): void;
  setSnapshot(snapshot: SimSnapshot): void;
  setSelection(id: string | null): void;
  setMode(mode: CanvasMode): void;
  setCompile(status: CompileStatus, diagnostics: Diagnostic[], hex: string | null): void;
  setBuildError(message: string | null): void;
}

export const useStudio = create<StudioState>((set) => ({
  project: emptyProject('Blink'),
  snapshot: EMPTY_SNAPSHOT,
  selection: null,
  mode: { kind: 'select' },

  compileStatus: 'idle',
  diagnostics: [],
  hex: null,
  buildError: null,

  setProject: (project) => set({ project }),

  addPart: (part) =>
    set((state) => ({ project: { ...state.project, parts: [...state.project.parts, part] } })),

  movePart: (id, x, y) =>
    set((state) => ({
      project: {
        ...state.project,
        parts: state.project.parts.map((p) => (p.id === id ? { ...p, x, y } : p)),
      },
    })),

  updatePartProps: (id, props) =>
    set((state) => ({
      project: {
        ...state.project,
        parts: state.project.parts.map((p) =>
          p.id === id ? { ...p, props: { ...p.props, ...props } } : p,
        ),
      },
    })),

  removePart: (id) =>
    set((state) => ({
      project: {
        ...state.project,
        parts: state.project.parts.filter((p) => p.id !== id),
        // Removing a part must take its wires with it, or the project references dead terminals.
        wires: state.project.wires.filter(
          (w) => !w.from.startsWith(`${id}:`) && !w.to.startsWith(`${id}:`),
        ),
      },
      selection: null,
    })),

  addWire: (wire) =>
    set((state) => ({ project: { ...state.project, wires: [...state.project.wires, wire] } })),

  removeWire: (id) =>
    set((state) => ({
      project: { ...state.project, wires: state.project.wires.filter((w) => w.id !== id) },
    })),

  setSketch: (name, contents) =>
    set((state) => ({
      project: {
        ...state.project,
        sketch: state.project.sketch.some((f) => f.name === name)
          ? state.project.sketch.map((f) => (f.name === name ? { ...f, contents } : f))
          : [...state.project.sketch, { name, contents }],
      },
    })),

  setSnapshot: (snapshot) => set({ snapshot }),
  setSelection: (selection) => set({ selection }),
  setMode: (mode) => set({ mode }),
  setCompile: (compileStatus, diagnostics, hex) =>
    set({ compileStatus, diagnostics, hex, buildError: null }),
  setBuildError: (buildError) => set({ buildError, compileStatus: 'error', hex: null }),
}));

/** Monotonic ids for newly placed parts and wires. */
let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}
