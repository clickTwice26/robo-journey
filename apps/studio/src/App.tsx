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
import { AccessGate, ResetLanding, VerifyLanding } from './panels/AccessGate.tsx';
import { applyCanvasPalette, buildTheme } from './theme.ts';
import { useThemeMode } from './useThemeMode.ts';
import { useAccess } from './useAccess.ts';
import { useStudio } from './store.ts';
import { useEffect, useState } from 'react';

/**
 * Where a link from an email has landed, if anywhere.
 *
 * Read once, at start-up. These are the only two paths the app treats as routes; everything else
 * is the app itself, and the server's catch-all serves the shell for all of them.
 */
function emailLanding(): { kind: 'verify' | 'reset'; token: string | null } | null {
  const { pathname, searchParams } = new URL(window.location.href);
  const token = searchParams.get('token');
  if (pathname === '/verify') return { kind: 'verify', token };
  if (pathname === '/reset-password') return { kind: 'reset', token };
  return null;
}

export function App() {
  const gate = useAccess();
  const themeControl = useThemeMode();

  // Applied during render rather than in an effect: the Konva tree reads these colours as it
  // builds, and an effect runs after the first paint -- which would show one frame of the previous
  // theme every time the app starts or the system setting flips.
  applyCanvasPalette(themeControl.mode);

  // dockview is styled by CSS variables rather than by the MUI theme, so the mode has to reach the
  // stylesheet as well.
  useEffect(() => {
    document.documentElement.dataset.theme = themeControl.mode;
    document.documentElement.style.colorScheme = themeControl.mode;
  }, [themeControl.mode]);
  // Captured once rather than watched: both screens rewrite the URL as soon as they have spent
  // their token, and re-reading it afterwards would send them back to a landing with nothing left
  // to do.
  // Cleared once the screen has finished with it, rather than read again from the URL: both
  // landings rewrite the address bar as soon as they spend their token, so re-reading would strand
  // a confirmed account on a page with nothing left to do.
  const [landing, setLanding] = useState(emailLanding);

  // Mirror the identity into the store, which the menu bar and the sync indicator read. The gate
  // remains the authority; this is a copy for convenience, not a second source of truth.
  useEffect(() => {
    useStudio.getState().setUser(gate.user);
  }, [gate.user]);

  return (
    <ThemeProvider theme={buildTheme(themeControl.mode)}>
      <CssBaseline />
      {landing?.kind === 'verify' ? (
        <VerifyLanding gate={gate} token={landing.token} onDone={() => setLanding(null)} />
      ) : landing?.kind === 'reset' ? (
        <ResetLanding gate={gate} token={landing.token} onDone={() => setLanding(null)} />
      ) : gate.phase === 'active' ? (
        <Studio gate={gate} theme={themeControl} />
      ) : (
        <AccessGate gate={gate} />
      )}
    </ThemeProvider>
  );
}
