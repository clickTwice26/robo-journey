/**
 * Application root, and the gate in front of it.
 *
 * An account is required to use the simulator, and a seat is required on top of that: ten people
 * at a time, an hour each. So the first thing this decides is whether there is a workspace to show
 * at all -- and when the answer is no, the workspace is not mounted rather than hidden.
 *
 * That distinction is what makes the rest of the app simple. Nothing below has to ask whether it
 * is allowed to run: if it is on screen, it is. No worker spins up for someone sitting in a queue,
 * and an hour ending unmounts the workspace, which flushes the autosave on the way out.
 */
import { CssBaseline, ThemeProvider } from '@mui/material';
import { Studio } from './Studio.tsx';
import { AccessGate } from './panels/AccessGate.tsx';
import { theme } from './theme.ts';
import { useAccess } from './useAccess.ts';
import { useStudio } from './store.ts';
import { useEffect } from 'react';

export function App() {
  const gate = useAccess();

  // Mirror the identity into the store, which the menu bar and the sync indicator read. The gate
  // remains the authority; this is a copy for convenience, not a second source of truth.
  useEffect(() => {
    useStudio.getState().setUser(gate.user);
  }, [gate.user]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {gate.phase === 'active' ? <Studio gate={gate} /> : <AccessGate gate={gate} />}
    </ThemeProvider>
  );
}
