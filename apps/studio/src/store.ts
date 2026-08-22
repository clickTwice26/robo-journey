/**
 * Application state.
 *
 * The project is the single source of truth: parts, wires and sketch. Everything the canvas draws
 * is derived from it, and everything the mouse does is a mutation of it. Simulation results arrive
 * separately as snapshots and are never merged in -- keeping measured values out of the document
 * is what makes save, undo and diff sane.
 */
import { create } from 'zustand';
import { PITCH_MM, emptyProject, type PartInstance, type Project, type Wire } from '@robo-journey/parts';
import { arrange, type Arrangement } from './canvas/arrange.ts';
import { EMPTY_SNAPSHOT, type SimSnapshot } from './sim/protocol.ts';
import { restoreWorkspace } from './persistence.ts';
import type { User } from './auth.ts';
import type { CanvasControls } from './canvas/Workspace.tsx';

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

/**
 * Undo depth.
 *
 * Deep enough to walk back out of a wrong turn, shallow enough that a hundred project snapshots
 * never become the largest thing in memory. Projects are small -- parts, wires and sketch text --
 * so whole-document snapshots are simpler and safer here than a command log, which has to get
 * every inverse right.
 */
const HISTORY_LIMIT = 100;

interface StudioState {
  project: Project;
  /** Previous project states, oldest first. */
  past: Project[];
  /** States undone but not yet superseded by a new edit. */
  future: Project[];
  snapshot: SimSnapshot;
  /**
   * Everything selected, in the order it was selected.
   *
   * A list rather than one id because arranging a circuit is a plural act: you line up four
   * sensors, you move a subassembly, you delete the half of the board that was a false start. The
   * last entry is the *primary* selection -- the one the Properties panel edits and the one a
   * sensing halo is drawn for -- so clicking a single part behaves exactly as it did.
   */
  selectedIds: string[];
  /** Marked on the canvas while a plan runs, so you can see which part each step is about. */
  agentFocus: string | null;
  mode: CanvasMode;
  /**
   * Whether buzzers are audible.
   *
   * On by default: a simulator that models a buzzer and then stays silent is answering a question
   * nobody asked. Off is one click away, because a 2 kHz square wave gets old.
   */
  soundOn: boolean;

  /**
   * A transient message, or null.
   *
   * One at a time on purpose: a stack of toasts is a stack of things to dismiss, and the second
   * one is almost always less interesting than the first. A newer message replaces an older one.
   */
  notice: { message: string; severity: 'success' | 'info' | 'warning' | 'error'; at: number } | null;

  /** Signed-in user, or null. Undefined until the first check completes. */
  user: User | null | undefined;
  /** Id of the account-stored project this document came from, if any. */
  cloudProjectId: string | null;
  /** Last time it synced to the account, for the status line. */
  syncedAt: Date | null;
  syncError: string | null;

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

  /** Replace the project, recording the current one for undo. */
  setProject(project: Project): void;
  /** Replace without touching history, for loading a fresh document. */
  loadProject(project: Project): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  addPart(part: PartInstance): void;
  rotatePart(id: string, degrees: number): void;
  movePart(id: string, x: number, y: number): void;
  /** Move one part to an absolute position and shift others by the same delta, in one update. */
  movePartWithAttached(id: string, x: number, y: number, attached: readonly string[]): void;
  updatePartProps(id: string, props: Record<string, unknown>): void;
  removePart(id: string): void;

  addWire(wire: Wire): void;
  removeWire(id: string): void;

  setSketch(name: string, contents: string): void;
  setUser(user: User | null): void;
  setCloudProject(id: string | null): void;
  setSyncState(syncedAt: Date | null, syncError: string | null): void;
  setSnapshot(snapshot: SimSnapshot): void;
  toggleSound(): void;
  /**
   * Zoom and fit, published by the canvas so the View menu can reach them.
   *
   * Functions rather than state, and deliberately so: the canvas owns its own pan and zoom, and
   * lifting that into the store would mean every pointer move during a drag went through it. This
   * is a handle to the canvas, not a copy of its state -- null while the workspace panel is closed,
   * which is exactly when the menu items should be disabled.
   */
  canvasControls: CanvasControls | null;
  setCanvasControls(controls: CanvasControls | null): void;
  /** Replace the selection. A bare id is the common case and reads better than a one-item list. */
  setSelection(id: string | null | readonly string[]): void;
  /** Add if absent, remove if present. Shift-click, and the only way to unpick one of many. */
  toggleSelected(id: string): void;
  selectAll(): void;
  /** Move every selected part by the same offset, as one history entry. */
  nudgeSelection(dx: number, dy: number): void;
  /** Turn every selected part a quarter, each about its own centre. */
  rotateSelection(degrees: number): void;
  /** Remove every selected part and the wires attached to them. */
  removeSelection(): void;
  /**
   * Copy the selection, offset by a hole so the copy is visibly not the original.
   *
   * Wires between two copied parts are copied too, and rewritten to point at the copies; a wire
   * with one end outside the selection is left behind, because duplicating it would silently
   * double the load on whatever it was attached to.
   */
  duplicateSelection(): void;
  /** Line the selection up, or space it evenly. See `arrange`. */
  arrangeSelection(how: Arrangement): void;
  /**
   * The part the agent is working on right now, or null.
   *
   * Separate from the selection because they mean different things: the selection is where *you*
   * are, and this is where the agent is. Conflating them would leave a part looking selected after
   * a run when you never selected it.
   */
  setAgentFocus(id: string | null): void;
  setMode(mode: CanvasMode): void;
  /** Say something briefly. `at` distinguishes two identical messages so the second still shows. */
  notify(message: string, severity?: 'success' | 'info' | 'warning' | 'error'): void;
  dismissNotice(): void;
  setCompile(status: CompileStatus, diagnostics: Diagnostic[], hex: string | null): void;
  setBuildError(message: string | null): void;
}

/**
 * Apply a change to the project while recording the previous state.
 *
 * Every mutator goes through this, so undo cannot be forgotten for one action and silently work
 * for the rest -- which is the failure mode that makes an undo stack untrustworthy.
 */
function withHistory(
  state: StudioState,
  change: (project: Project) => Project,
): Partial<StudioState> {
  const next = change(state.project);
  if (next === state.project) return {};
  return {
    project: next,
    past: [...state.past, state.project].slice(-HISTORY_LIMIT),
    // Any new edit discards the redo branch, as every editor does.
    future: [],
  };
}

/**
 * Open with whatever was last being worked on.
 *
 * Restoring at store creation rather than in an effect means the first render already has the
 * user's circuit -- no flash of an empty canvas, and no risk of an autosave firing against the
 * default document before the restore lands and wiping the real one.
 */
const initialProject = restoreWorkspace()?.project ?? emptyProject('Blink');

export const useStudio = create<StudioState>((set, get) => ({
  project: initialProject,
  past: [],
  future: [],
  snapshot: EMPTY_SNAPSHOT,
  soundOn: true,
  notice: null,
  selectedIds: [],
  agentFocus: null,
  mode: { kind: 'select' },

  user: undefined,
  cloudProjectId: null,
  syncedAt: null,
  syncError: null,

  compileStatus: 'idle',
  diagnostics: [],
  hex: null,
  buildError: null,

  setProject: (project) => set((state) => withHistory(state, () => project)),

  // A freshly opened document has no history and is not yet tied to an account project.
  loadProject: (project) => set({ project, past: [], future: [], cloudProjectId: null, syncedAt: null }),

  undo: () =>
    set((state) => {
      const previous = state.past[state.past.length - 1];
      if (!previous) return {};
      return {
        project: previous,
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future].slice(0, HISTORY_LIMIT),
        selectedIds: [],
      };
    }),

  redo: () =>
    set((state) => {
      const [next, ...rest] = state.future;
      if (!next) return {};
      return {
        project: next,
        past: [...state.past, state.project].slice(-HISTORY_LIMIT),
        future: rest,
        selectedIds: [],
      };
    }),

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  addPart: (part) =>
    set((state) => withHistory(state, (p) => ({ ...p, parts: [...p.parts, part] }))),

  /**
   * Turn a part on the spot.
   *
   * Wrapped to 0-359 so the number in the inspector stays readable after a few turns, and about
   * the part's origin because that is where the canvas and the terminal map both rotate it. Wires
   * follow because they are drawn from that same map rather than from remembered coordinates.
   */
  rotatePart: (id, degrees) =>
    set((state) =>
      withHistory(state, (p) => ({
        ...p,
        parts: p.parts.map((part) =>
          part.id === id ? { ...part, rotation: ((degrees % 360) + 360) % 360 } : part,
        ),
      })),
    ),

  movePart: (id, x, y) =>
    set((state) =>
      withHistory(state, (p) => ({
        ...p,
        parts: p.parts.map((part) => (part.id === id ? { ...part, x, y } : part)),
      })),
    ),

  movePartWithAttached: (id, x, y, attached) =>
    set((state) =>
      withHistory(state, (project) => {
        const anchor = project.parts.find((p) => p.id === id);
        if (!anchor) return project;
        const dx = x - anchor.x;
        const dy = y - anchor.y;
        const moving = new Set(attached);

        return {
          ...project,
          parts: project.parts.map((part) => {
            if (part.id === id) return { ...part, x, y };
            if (!moving.has(part.id)) return part;
            return { ...part, x: part.x + dx, y: part.y + dy };
          }),
        };
      }),
    ),

  updatePartProps: (id, props) =>
    set((state) =>
      withHistory(state, (p) => ({
        ...p,
        parts: p.parts.map((part) =>
          part.id === id ? { ...part, props: { ...part.props, ...props } } : part,
        ),
      })),
    ),

  removePart: (id) =>
    set((state) => ({
      ...withHistory(state, (p) => ({
        ...p,
        parts: p.parts.filter((part) => part.id !== id),
        // Removing a part must take its wires with it, or the project references dead terminals.
        wires: p.wires.filter((w) => !w.from.startsWith(`${id}:`) && !w.to.startsWith(`${id}:`)),
      })),
      selectedIds: [],
    })),

  addWire: (wire) =>
    set((state) => withHistory(state, (p) => ({ ...p, wires: [...p.wires, wire] }))),

  removeWire: (id) =>
    set((state) => withHistory(state, (p) => ({ ...p, wires: p.wires.filter((w) => w.id !== id) }))),

  // Sketch edits deliberately bypass the undo stack: Monaco has its own, far better, undo for
  // text, and pushing a snapshot per keystroke would bury every circuit edit under a thousand
  // character-level entries.
  setSketch: (name, contents) =>
    set((state) => ({
      project: {
        ...state.project,
        sketch: state.project.sketch.some((f) => f.name === name)
          ? state.project.sketch.map((f) => (f.name === name ? { ...f, contents } : f))
          : [...state.project.sketch, { name, contents }],
      },
    })),

  setUser: (user) =>
    set((state) => ({
      user,
      // Signing out must not leave the document pointing at an account project it can no longer
      // reach, or the next save would fail silently.
      cloudProjectId: user ? state.cloudProjectId : null,
      syncedAt: user ? state.syncedAt : null,
      syncError: null,
    })),
  setCloudProject: (cloudProjectId) => set({ cloudProjectId, syncError: null }),
  setSyncState: (syncedAt, syncError) => set({ syncedAt, syncError }),

  setSnapshot: (snapshot) => set({ snapshot }),
  toggleSound: () => set((state) => ({ soundOn: !state.soundOn })),
  canvasControls: null,
  setCanvasControls: (canvasControls) => set({ canvasControls }),
  setSelection: (id) =>
    set({ selectedIds: id === null ? [] : typeof id === 'string' ? [id] : [...id] }),

  toggleSelected: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds.filter((s) => s !== id)
        // Appended, so the thing you just shift-clicked becomes the primary and the panel follows
        // your hand rather than staying on whatever you picked first.
        : [...state.selectedIds, id],
    })),

  selectAll: () => set((state) => ({ selectedIds: state.project.parts.map((p) => p.id) })),

  nudgeSelection: (dx, dy) =>
    set((state) => {
      const chosen = new Set(state.selectedIds);
      if (chosen.size === 0) return {};
      return withHistory(state, (p) => ({
        ...p,
        parts: p.parts.map((part) =>
          chosen.has(part.id) ? { ...part, x: part.x + dx, y: part.y + dy } : part,
        ),
      }));
    }),

  rotateSelection: (degrees) =>
    set((state) => {
      const chosen = new Set(state.selectedIds);
      if (chosen.size === 0) return {};
      return withHistory(state, (p) => ({
        ...p,
        parts: p.parts.map((part) =>
          chosen.has(part.id)
            ? { ...part, rotation: ((part.rotation + degrees) % 360 + 360) % 360 }
            : part,
        ),
      }));
    }),

  removeSelection: () =>
    set((state) => {
      const chosen = new Set(state.selectedIds);
      if (chosen.size === 0) return {};
      const attached = (terminal: string) => chosen.has(terminal.slice(0, terminal.indexOf(':')));
      return {
        ...withHistory(state, (p) => ({
          ...p,
          parts: p.parts.filter((part) => !chosen.has(part.id)),
          wires: p.wires.filter((w) => !attached(w.from) && !attached(w.to)),
        })),
        selectedIds: [],
      };
    }),

  duplicateSelection: () =>
    set((state) => {
      const chosen = new Set(state.selectedIds);
      if (chosen.size === 0) return {};

      const originals = state.project.parts.filter((part) => chosen.has(part.id));
      const renamed = new Map<string, string>();
      const copies = originals.map((part) => {
        const id = nextId(part.type.slice(0, 2));
        renamed.set(part.id, id);
        return { ...part, id, x: part.x + PITCH_MM, y: part.y + PITCH_MM };
      });

      // Only wires with *both* ends inside the selection. One end outside would mean the copy
      // shares a terminal with the original, which is a second load on it rather than a copy.
      const rewrite = (terminal: string) => {
        const cut = terminal.indexOf(':');
        const id = renamed.get(terminal.slice(0, cut));
        return id === undefined ? null : `${id}${terminal.slice(cut)}`;
      };
      const wires = state.project.wires.flatMap((w) => {
        const from = rewrite(w.from);
        const to = rewrite(w.to);
        return from && to ? [{ ...w, id: nextId('w'), from, to }] : [];
      });

      return {
        ...withHistory(state, (p) => ({
          ...p,
          parts: [...p.parts, ...copies],
          wires: [...p.wires, ...wires],
        })),
        // The copies become the selection, so the next drag moves what you just made.
        selectedIds: copies.map((c) => c.id),
      };
    }),

  arrangeSelection: (how) =>
    set((state) => {
      const chosen = new Set(state.selectedIds);
      if (chosen.size < 2) return {};
      const moved = arrange(
        state.project.parts.filter((part) => chosen.has(part.id)),
        how,
      );
      if (moved.size === 0) return {};
      return withHistory(state, (p) => ({
        ...p,
        parts: p.parts.map((part) => {
          const at = moved.get(part.id);
          return at ? { ...part, x: at.x, y: at.y } : part;
        }),
      }));
    }),
  setAgentFocus: (agentFocus) => set({ agentFocus }),
  setMode: (mode) => set({ mode }),
  notify: (message, severity = 'info') =>
    set({ notice: { message, severity, at: Date.now() } }),
  dismissNotice: () => set({ notice: null }),
  setCompile: (compileStatus, diagnostics, hex) =>
    set({ compileStatus, diagnostics, hex, buildError: null }),
  setBuildError: (buildError) => set({ buildError, compileStatus: 'error', hex: null }),
}));

/**
 * Ids for newly placed parts and wires.
 *
 * The counter alone is not enough, and the way it failed is worth recording. It restarts at zero
 * on every page load, so opening a saved project -- whose ids came from a previous run of the same
 * counter -- and then placing a part hands out an id the document already contains. The engine
 * keys its devices by part id, so the two parts share one device and the second sensor placed
 * silently stops responding: place a heat source into a restored workspace and the sensor you
 * added just before it goes dead.
 *
 * So the project gets the final say. The counter still only moves forward, which keeps ids stable
 * within a session; it just skips anything already spoken for.
 */
/**
 * The part the panels act on: the last one picked.
 *
 * Selecting six things and asking the inspector to show "the" resistance is not a question with an
 * answer, so the panels follow the most recent pick and say plainly when there are others behind
 * it. Shift-clicking appends, which is what makes the panel follow your hand.
 */
export const primarySelection = (state: StudioState): string | null =>
  state.selectedIds[state.selectedIds.length - 1] ?? null;

let counter = 0;
export function nextId(prefix: string): string {
  const { project } = useStudio.getState();
  const taken = new Set<string>([
    ...project.parts.map((p) => p.id),
    ...project.wires.map((w) => w.id),
  ]);

  let id: string;
  do {
    counter += 1;
    id = `${prefix}${counter}`;
  } while (taken.has(id));
  return id;
}
