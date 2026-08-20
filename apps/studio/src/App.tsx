/**
 * Application shell.
 *
 * dockview provides the VS Code-style dockable layout: every panel can be moved, split, resized or
 * popped out, and the arrangement serialises — which is how a shared project will later open with
 * the scope already pointing at the right pins.
 */
import { Box, CssBaseline, ThemeProvider } from '@mui/material';
// dockview 8 split its framework bindings out: the core package is framework-agnostic and the
// React components live in `dockview-react`. Styles still ship with the core.
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview-react';
import 'dockview/dist/styles/dockview.css';
import { useCallback, useMemo, useRef, useState } from 'react';
import { MenuBar, PANELS, type MenuBarActions } from './MenuBar.tsx';
import { theme } from './theme.ts';
import { useSimulation } from './sim/useSimulation.ts';
import { WorkspacePanel } from './panels/WorkspacePanel.tsx';
import { EditorPanel } from './panels/Editor.tsx';
import { SerialPanel } from './panels/Serial.tsx';
import { ProblemsPanel } from './panels/Problems.tsx';
import { PalettePanel } from './panels/Palette.tsx';
import { ScopePanel } from './panels/Scope.tsx';
import { InspectorPanel } from './panels/Inspector.tsx';
import { DisassemblyPanel } from './panels/Disassembly.tsx';
import { DatasheetDialog } from './panels/DatasheetDialog.tsx';

/** Titles by panel id, so a closed panel can be recreated with the name it had. */
const PANEL_TITLES = new Map<string, string>(PANELS.map((panel) => [panel.id, panel.title]));

export function App() {
  const sim = useSimulation();
  const apiRef = useRef<DockviewApi | null>(null);
  const [datasheetOpen, setDatasheetOpen] = useState(false);
  /**
   * Bumped whenever the dockview layout changes.
   *
   * Also a memo dependency for `menuActions`: the api only exists after `onReady`, so a memo keyed
   * solely on stable values would cache the `null` from the first render and leave the View menu
   * reporting every panel as closed forever.
   */
  const [revision, forceRender] = useState(0);

  // Panels that query the worker take the controller. Defined inside the component so it is in
  // scope; memoised on the controller, which `useSimulation` keeps referentially stable.
  const components = useMemo(
    () => ({
      workspace: (_props: IDockviewPanelProps) => <WorkspacePanel />,
      editor: (_props: IDockviewPanelProps) => <EditorPanel />,
      serial: (_props: IDockviewPanelProps) => <SerialPanel />,
      problems: (_props: IDockviewPanelProps) => <ProblemsPanel />,
      palette: (_props: IDockviewPanelProps) => <PalettePanel />,
      scope: (_props: IDockviewPanelProps) => <ScopePanel sim={sim} />,
      inspector: (_props: IDockviewPanelProps) => <InspectorPanel sim={sim} />,
      disassembly: (_props: IDockviewPanelProps) => <DisassemblyPanel sim={sim} />,
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

    api.addPanel({
      id: 'editor',
      component: 'editor',
      title: 'sketch.ino',
      position: { direction: 'right', referencePanel: workspace },
      initialWidth: editorWidth,
    });

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
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        <MenuBar sim={sim} actions={menuActions} onOpenDatasheet={() => setDatasheetOpen(true)} />
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <DockviewReact components={components} onReady={onReady} className="dockview-theme-abyss" />
        </Box>
      </Box>

      {/* Hosted at the shell so it can be opened from the File menu as well as the palette. */}
      <DatasheetDialog
        open={datasheetOpen}
        onClose={() => setDatasheetOpen(false)}
        onAdded={() => forceRender((n) => n + 1)}
      />
    </ThemeProvider>
  );
}
