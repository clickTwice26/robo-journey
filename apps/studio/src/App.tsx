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
import { useThemeMode, type ThemeControl } from './useThemeMode.ts';
import { useAccess } from './useAccess.ts';
import { useStudio } from './store.ts';
import { Landing } from './Landing.tsx';
import { useCallback, useEffect, useState } from 'react';

/** Where the app is. The server's catch-all serves the shell for every one of these. */
export const APP_PATH = '/app';

type Route =
  | { kind: 'landing' }
  | { kind: 'app' }
  | { kind: 'verify'; token: string | null }
  | { kind: 'reset'; token: string | null };

/**
 * Which of the four screens the address bar is asking for.
 *
 * Deliberately not a router: there are four paths, none of them nested, and a routing library for
 * that is a dependency to keep current forever in exchange for nothing.
 */
function routeFor(href: string): Route {
  const { pathname, searchParams } = new URL(href);
  const token = searchParams.get('token');
  if (pathname === '/verify') return { kind: 'verify', token };
  if (pathname === '/reset-password') return { kind: 'reset', token };
  if (pathname.startsWith(APP_PATH)) return { kind: 'app' };
  return { kind: 'landing' };
}

/**
 * Everything behind the gate.
 *
 * Its own component so that `useAccess` is not mounted on the landing page. That hook is what
 * checks the session, holds a seat and sends the heartbeat -- run it for a visitor reading the
 * marketing page and an already-seated user spends their hour on it, which is the opposite of what
 * a landing page is for. Anonymous visitors also make no request at all.
 */
function Gated({
  route,
  theme,
  onLeave,
}: {
  route: Route;
  theme: ThemeControl;
  onLeave(path: string): void;
}) {
  const gate = useAccess();

  // Mirror the identity into the store, which the menu bar, the account menu and the sync
  // indicator all read. The gate remains the authority; this is a copy for convenience, not a
  // second source of truth.
  useEffect(() => {
    useStudio.getState().setUser(gate.user);
  }, [gate.user]);

  if (route.kind === 'verify') {
    return <VerifyLanding gate={gate} token={route.token} onDone={() => onLeave(APP_PATH)} />;
  }
  if (route.kind === 'reset') {
    return <ResetLanding gate={gate} token={route.token} onDone={() => onLeave(APP_PATH)} />;
  }
  return gate.phase === 'active' ? <Studio gate={gate} theme={theme} /> : <AccessGate gate={gate} />;
}

export function App() {
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
  // Captured once rather than watched, and cleared by the screen that spends it: both email
  // landings rewrite the address bar as soon as they are done, and re-reading it afterwards would
  // strand a confirmed account on a page with nothing left to do.
  const [route, setRoute] = useState<Route>(() => routeFor(window.location.href));

  /** Move between the landing and the app without reloading a bundle that is already here. */
  const go = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    setRoute(routeFor(window.location.href));
    window.scrollTo(0, 0);
  }, []);

  // Back and forward have to work. Someone who presses Try now and then reaches for the back
  // button expects the page they came from, not a dead end.
  useEffect(() => {
    const onPop = () => setRoute(routeFor(window.location.href));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return (
    <ThemeProvider theme={buildTheme(themeControl.mode)}>
      <CssBaseline />
      {route.kind === 'landing' ? (
        <Landing onEnter={() => go(APP_PATH)} />
      ) : (
        <Gated route={route} theme={themeControl} onLeave={go} />
      )}
    </ThemeProvider>
  );
}
