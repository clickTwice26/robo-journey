/**
 * The workspace.
 *
 * dockview provides the VS Code-style dockable layout: every panel can be moved, split, resized or
 * popped out, and the arrangement serialises — which is how a shared project will later open with
 * the scope already pointing at the right pins.
 *
 * Mounted only while its owner holds a seat, which is why the simulation worker, the autosave and
 * the panel layout all live here rather than in `App`: someone sitting in the queue should not
 * have a worker running, and someone whose hour ends should have their work flushed by this
 * component coming down.
 */
import { Box, Fade, Paper, Typography } from '@mui/material';
// dockview 8 split its framework bindings out: the core package is framework-agnostic and the
// React components live in `dockview-react`. Styles still ship with the core.
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview-react';
import 'dockview/dist/styles/dockview.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MenuBar, PANELS, type MenuBarActions } from './MenuBar.tsx';
import { useSimulation } from './sim/useSimulation.ts';
import { WorkspacePanel } from './panels/WorkspacePanel.tsx';
import { EditorPanel } from './panels/Editor.tsx';
import { SerialPanel } from './panels/Serial.tsx';
import { ProblemsPanel } from './panels/Problems.tsx';
import { PalettePanel } from './panels/Palette.tsx';
import { PropertiesPanel } from './panels/Properties.tsx';
import { ScopePanel } from './panels/Scope.tsx';
import { InspectorPanel } from './panels/Inspector.tsx';
import { DisassemblyPanel } from './panels/Disassembly.tsx';
import { AssistantPanel } from './panels/Assistant.tsx';
import { DatasheetDialog } from './panels/DatasheetDialog.tsx';
import { CloudProjectsDialog } from './panels/CloudProjectsDialog.tsx';
import { LibraryDialog } from './panels/LibraryDialog.tsx';
import { HelpDialog, type HelpTopic } from './panels/HelpDialog.tsx';
import { Notices } from './panels/Notices.tsx';
import { InviteDialog } from './panels/InviteDialog.tsx';
import { UpgradeDialog } from './panels/UpgradeDialog.tsx';
import { useBuzzerAudio } from './sim/useAudio.ts';
import type { ThemeControl } from './useThemeMode.ts';
import { restoreLibrary } from './library.ts';
import type { AccessGate as Gate } from './useAccess.ts';
import { AUTOSAVE_DELAY_MS, saveWorkspace } from './persistence.ts';
import { primarySelection, useStudio } from './store.ts';

/**
 * "Still there?"
 *
 * A seat is passed on after two minutes with nobody at the keyboard, and losing one mid-thought
 * with no warning would be indefensible -- someone reading their own sketch is working, even if
 * the mouse has not moved. This appears with half a minute left and disappears the instant
 * anything is touched, which is all it takes to dismiss it.
 */
function IdleWarning({ remaining }: { remaining: number | null }) {
  return (
    <Fade in={remaining !== null}>
      <Paper
        elevation={8}
        sx={{
          position: 'fixed',
          top: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: (theme) => theme.zIndex.tooltip,
          px: 2.5,
          py: 1.25,
          border: 1,
          borderColor: 'warning.main',
          pointerEvents: 'none',
          textAlign: 'center',
        }}
      >
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Still there?
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Your seat passes to the next person in{' '}
          {Math.ceil((remaining ?? 0) / 1000)}s. Move the mouse or press a key.
        </Typography>
      </Paper>
    </Fade>
  );
}

/** Titles by panel id, so a closed panel can be recreated with the name it had. */
const PANEL_TITLES = new Map<string, string>(PANELS.map((panel) => [panel.id, panel.title]));

export function Studio({ gate, theme }: { gate: Gate; theme: ThemeControl }) {
  const sim = useSimulation();
  const apiRef = useRef<DockviewApi | null>(null);
  const [datasheetOpen, setDatasheetOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [libraryGroup, setLibraryGroup] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [helpTopic, setHelpTopic] = useState<HelpTopic | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  // Buzzers, out loud. The pitch and loudness come from the worker's measurement of the actual
  // drive waveform, so this plays what the circuit is doing rather than a sound effect.
  const sounds = useStudio((s) => s.snapshot.sounds);
  const soundOn = useStudio((s) => s.soundOn);
  useBuzzerAudio(sounds, soundOn);
  /**
   * Bumped whenever the dockview layout changes.
   *
   * Also a memo dependency for `menuActions`: the api only exists after `onReady`, so a memo keyed
   * solely on stable values would cache the `null` from the first render and leave the View menu
   * reporting every panel as closed forever.
   */
  const [revision, forceRender] = useState(0);

  /**
   * Restore components the user has added.
   *
   * Before anything else touches the simulation, because a restored project may reference one of
   * them and the worker has to know the part exists before it is asked to build it.
   */
  useEffect(() => {
    restoreLibrary(sim);
  }, [sim]);

  /**
   * Autosave.
   *
   * Debounced, so dragging a part or typing a line does not write on every frame, and subscribed
   * to the store directly rather than through a hook -- an autosave should not be a reason for the
   * whole shell to re-render.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const unsubscribe = useStudio.subscribe((state, previous) => {
      if (state.project === previous.project) return;
      clearTimeout(timer);
      timer = setTimeout(() => saveWorkspace(useStudio.getState().project), AUTOSAVE_DELAY_MS);
    });

    // Flush on the way out, so closing the tab mid-debounce still keeps the last edit.
    const flush = () => saveWorkspace(useStudio.getState().project);
    window.addEventListener('pagehide', flush);

    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  // Panels that query the worker take the controller. Defined inside the component so it is in
  // scope; memoised on the controller, which `useSimulation` keeps referentially stable.
  const components = useMemo(
    () => ({
      workspace: (_props: IDockviewPanelProps) => (
        <WorkspacePanel
          onOpenLibrary={() => setLibraryOpen(true)}
          // Through the ref rather than the memoised value: `menuActions` is null on the first
          // render, and capturing that null here would leave the button permanently inert.
          onAskAi={() => {
            const api = apiRef.current;
            const existing = api?.getPanel('assistant');
            if (existing) existing.api.setActive();
            else
              api?.addPanel({
                id: 'assistant',
                component: 'assistant',
                title: PANEL_TITLES.get('assistant') ?? 'Assistant',
                position: { referencePanel: 'editor', direction: 'within' },
              });
          }}
        />
      ),
      editor: (_props: IDockviewPanelProps) => <EditorPanel />,
      serial: (_props: IDockviewPanelProps) => <SerialPanel />,
      problems: (_props: IDockviewPanelProps) => <ProblemsPanel />,
      palette: (_props: IDockviewPanelProps) => <PalettePanel sim={sim} />,
      properties: (_props: IDockviewPanelProps) => <PropertiesPanel />,
      scope: (_props: IDockviewPanelProps) => <ScopePanel sim={sim} />,
      inspector: (_props: IDockviewPanelProps) => <InspectorPanel sim={sim} />,
      disassembly: (_props: IDockviewPanelProps) => <DisassemblyPanel sim={sim} />,
      assistant: (_props: IDockviewPanelProps) => <AssistantPanel />,
    }),
    [sim],
  );

  /**
   * Default layout: canvas centre stage, palette left, code right, diagnostics below.
   *
   * Deliberately mirrors the shape of the work — you look at the circuit, reach left for parts,
   * right for code, and down when something is wrong.
   */
  const buildLayout = useCallback((api: DockviewApi) => {
    // Proportional, not fixed pixels. A 460 px editor is a third of a wide screen and almost all
    // of a laptop one, which would leave the canvas — the thing the app is actually about —
    // unusable on the smaller machine.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const paletteWidth = Math.max(160, Math.min(260, Math.round(vw * 0.14)));
    const editorWidth = Math.max(280, Math.min(560, Math.round(vw * 0.3)));
    const bottomHeight = Math.max(140, Math.min(280, Math.round(vh * 0.24)));

    const workspace = api.addPanel({ id: 'workspace', component: 'workspace', title: 'Workspace' });

    api.addPanel({
      id: 'palette',
      component: 'palette',
      title: 'Parts',
      position: { direction: 'left', referencePanel: workspace },
      initialWidth: paletteWidth,
    });

    const editor = api.addPanel({
      id: 'editor',
      component: 'editor',
      title: 'sketch.ino',
      position: { direction: 'right', referencePanel: workspace },
      initialWidth: editorWidth,
    });

    // Tabbed with the editor rather than in the bottom strip: a conversation needs height, and the
    // bottom row is where short readouts live.
    api.addPanel({
      id: 'assistant',
      component: 'assistant',
      title: 'Assistant',
      position: { referencePanel: editor, direction: 'within' },
    });

    // Properties joins the same group rather than taking a slice of height from it. Selecting a
    // part is a moment, not a mode: you click something, read it, adjust it and go back to the
    // code, and a permanent panel would spend most of its life empty while making the editor
    // shorter. Clicking a part on the canvas brings this tab forward -- see the effect below.
    api.addPanel({
      id: 'properties',
      component: 'properties',
      title: 'Properties',
      position: { referencePanel: editor, direction: 'within' },
    });

    editor.api.setActive();

    const problems = api.addPanel({
      id: 'problems',
      component: 'problems',
      title: 'Problems',
      position: { direction: 'below', referencePanel: workspace },
      initialHeight: bottomHeight,
    });

    for (const id of ['serial', 'scope', 'inspector', 'disassembly'] as const) {
      api.addPanel({
        id,
        component: id,
        title: PANEL_TITLES.get(id) ?? id,
        position: { referencePanel: problems, direction: 'within' },
      });
    }

    problems.api.setActive();
  }, []);

  /**
   * Clicking a part on the canvas brings its properties forward.
   *
   * Subscribed to the store directly rather than through a hook: this has to react to a selection
   * without making the whole shell re-render every time one changes, and the shell is the most
   * expensive thing on the page to re-render.
   *
   * Only ever activates a panel that is already open. Re-opening one somebody deliberately closed,
   * on every single click, would be the app arguing with them.
   */
  useEffect(() => {
    let previous = primarySelection(useStudio.getState());

    return useStudio.subscribe((state) => {
      const selection = primarySelection(state);
      if (selection === previous) return;
      previous = selection;
      if (selection === null) return;
      apiRef.current?.getPanel('properties')?.api.setActive();
    });
  }, []);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      buildLayout(event.api);

      // Track panels dockview adds or removes on its own -- a panel closed by its X, or moved
      // between groups. Without this the View menu only reflects changes the menu itself made,
      // and reports a panel the user just closed as still open.
      const bump = () => forceRender((n) => n + 1);
      event.api.onDidAddPanel(bump);
      event.api.onDidRemovePanel(bump);

      bump();
    },
    [buildLayout],
  );

  /**
   * What the View menu drives.
   *
   * A closed panel is gone from dockview entirely, so "show" has to recreate it rather than merely
   * focus it — otherwise closing a panel would make its menu entry permanently inert.
   */
  const menuActions = useMemo<MenuBarActions | null>(() => {
    const api = apiRef.current;
    if (!api) return null;

    return {
      isPanelOpen: (id) => api.getPanel(id) !== undefined,
      showPanel: (id) => {
        const existing = api.getPanel(id);
        if (existing) {
          existing.api.setActive();
          return;
        }
        // `component` keys are the panel ids, which is why the two are interchangeable here; the
        // cast tells TypeScript that, since the View menu only ever passes known ids.
        api.addPanel({
          id,
          component: id as keyof typeof components,
          title: PANEL_TITLES.get(id) ?? id,
        });
        forceRender((n) => n + 1);
      },
      resetLayout: () => {
        api.clear();
        buildLayout(api);
        forceRender((n) => n + 1);
      },
    };
  }, [buildLayout, components, revision]);

  return (
    <>
      <IdleWarning remaining={gate.idleWarningMs} />
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        <MenuBar
          sim={sim}
          actions={menuActions}
          gate={gate}
          theme={theme}
          onOpenDatasheet={() => setDatasheetOpen(true)}
          onOpenCloudProjects={() => setCloudOpen(true)}
          onOpenLibrary={(groupId) => {
            setLibraryGroup(groupId ?? null);
            setLibraryOpen(true);
          }}
          onOpenHelp={setHelpTopic}
          onOpenInvite={() => setInviteOpen(true)}
          onOpenUpgrade={() => setUpgradeOpen(true)}
        />
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <DockviewReact components={components} onReady={onReady} className="dockview-theme-abyss" />
        </Box>
      </Box>

      {/* Hosted at the shell so it can be opened from the File menu as well as the palette. */}
      <DatasheetDialog
        sim={sim}
        open={datasheetOpen}
        onClose={() => setDatasheetOpen(false)}
        onAdded={() => forceRender((n) => n + 1)}
      />

      <CloudProjectsDialog open={cloudOpen} onClose={() => setCloudOpen(false)} />
      <LibraryDialog
        open={libraryOpen}
        initialGroup={libraryGroup}
        onClose={() => setLibraryOpen(false)}
      />
      <HelpDialog topic={helpTopic} onClose={() => setHelpTopic(null)} />
      <Notices />
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <UpgradeDialog open={upgradeOpen} onClose={() => setUpgradeOpen(false)} />
    </>
  );
}
