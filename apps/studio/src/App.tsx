/**
 * Application shell.
 *
 * dockview provides the VS Code-style dockable layout: every panel can be moved, split, resized or
 * popped out, and the arrangement serialises -- which is how a shared project will later open with
 * the scope already pointing at the right pins.
 */
import { Box, CssBaseline, ThemeProvider } from '@mui/material';
// dockview 8 split its framework bindings out: the core package is framework-agnostic and the
// React components live in `dockview-react`. Styles still ship with the core.
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview-react';
import 'dockview/dist/styles/dockview.css';
import { useCallback } from 'react';
import { Toolbar } from './Toolbar.tsx';
import { theme } from './theme.ts';
import { useSimulation } from './sim/useSimulation.ts';
import { WorkspacePanel } from './panels/WorkspacePanel.tsx';
import { EditorPanel } from './panels/Editor.tsx';
import { SerialPanel } from './panels/Serial.tsx';
import { ProblemsPanel } from './panels/Problems.tsx';
import { PalettePanel } from './panels/Palette.tsx';

const components = {
  workspace: (_props: IDockviewPanelProps) => <WorkspacePanel />,
  editor: (_props: IDockviewPanelProps) => <EditorPanel />,
  serial: (_props: IDockviewPanelProps) => <SerialPanel />,
  problems: (_props: IDockviewPanelProps) => <ProblemsPanel />,
  palette: (_props: IDockviewPanelProps) => <PalettePanel />,
};

export function App() {
  const sim = useSimulation();

  /**
   * Default layout: canvas centre stage, palette left, code right, diagnostics below.
   *
   * Deliberately mirrors the shape of the work -- you look at the circuit, reach left for parts,
   * right for code, and down when something is wrong.
   */
  const onReady = useCallback((event: DockviewReadyEvent) => {
    // Proportional, not fixed pixels. A 460 px editor is a third of a wide screen and almost all
    // of a laptop one, which would leave the canvas -- the thing the app is actually about --
    // unusable on the smaller machine.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const paletteWidth = Math.max(160, Math.min(240, Math.round(vw * 0.14)));
    const editorWidth = Math.max(280, Math.min(560, Math.round(vw * 0.3)));
    const bottomHeight = Math.max(120, Math.min(260, Math.round(vh * 0.22)));

    const workspace = event.api.addPanel({
      id: 'workspace',
      component: 'workspace',
      title: 'Workspace',
    });

    event.api.addPanel({
      id: 'palette',
      component: 'palette',
      title: 'Parts',
      position: { direction: 'left', referencePanel: workspace },
      initialWidth: paletteWidth,
    });

    event.api.addPanel({
      id: 'editor',
      component: 'editor',
      title: 'sketch.ino',
      position: { direction: 'right', referencePanel: workspace },
      initialWidth: editorWidth,
    });

    const problems = event.api.addPanel({
      id: 'problems',
      component: 'problems',
      title: 'Problems',
      position: { direction: 'below', referencePanel: workspace },
      initialHeight: bottomHeight,
    });

    event.api.addPanel({
      id: 'serial',
      component: 'serial',
      title: 'Serial Monitor',
      position: { referencePanel: problems, direction: 'within' },
    });

    problems.api.setActive();
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        <Toolbar sim={sim} />
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <DockviewReact components={components} onReady={onReady} className="dockview-theme-abyss" />
        </Box>
      </Box>
    </ThemeProvider>
  );
}
