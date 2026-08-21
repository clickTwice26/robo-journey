/**
 * The gate.
 *
 * Everything in the simulator sits behind this. It is a full screen rather than a dialog because
 * that is the truth of it: there is no workspace behind the overlay to go back to, and a dialog
 * over a greyed-out canvas would suggest otherwise.
 *
 * The one rule the whole screen is built around is that people should never be surprised: the
 * cooldown counts down rather than saying "later", a seat passed on for idleness says so and says
 * the time is kept, and the fact that leaving early costs the same wait as running out of time is
 * stated up front rather than discovered afterwards.
 *
 * What it does *not* show is deliberate too. No seat count, no queue length in numbers, no
 * estimated wait. A wait estimate is a promise that cannot be kept -- it moves every time anyone
 * leaves early or gives up -- and quoting one invites people to work out when to come back
 * instead of simply being let in when it is their turn.
 */
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import MarkEmailUnreadIcon from '@mui/icons-material/MarkEmailUnread';
import { Tooltip } from '@mui/material';
import GroupsIcon from '@mui/icons-material/Groups';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import { useCallback, useEffect, useState } from 'react';
import {
  AuthError,
  login,
  register,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
  type AccessStatus,
} from '../auth.ts';
import type { AccessGate as Gate } from '../useAccess.ts';
import { clearInvite, pendingInvite } from '../invite.ts';

/** Mirrors the server's minimum, so the hint appears before a round trip rejects it. */
const MIN_PASSWORD_LENGTH = 10;

/** A countdown that re-renders once a second, and only while there is something to count. */
function useCountdown(target: string | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!target) {
      setRemaining(null);
      return;
    }
    const at = new Date(target).getTime();
    const tick = () => setRemaining(Math.max(0, at - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [target]);

  return remaining;
}

/** "24 minutes", "1:59", "under a minute" -- whichever reads best at that scale. */
export function formatDuration(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}:${String(rest).padStart(2, '0')}`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 2,
        bgcolor: 'background.default',
      }}
    >
      <Paper elevation={0} sx={{ p: 4, width: '100%', maxWidth: 440, border: 1, borderColor: 'divider' }}>
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.5 }}>
          robo-journey
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Hardware-accurate Arduino circuit simulator
        </Typography>
        {children}
      </Paper>
    </Box>
  );
}

/** The rules, stated once, where someone is about to be subject to them. */
function Rules() {
  return (
    <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 2 }}>
      Accounts are free. Only so many people can use the simulator at once, for an hour each;
    </Typography>
  );
}

// ---------------------------------------------------------------------------------------------

function SignIn({ gate }: { gate: Gate }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const session =
        mode === 'login'
          ? await login(email, password)
          : await register(email, password, displayName, pendingInvite());
      // Spent, whether or not it was any good: the server ignores a bad one, and keeping it would
      // mean trying it again on the next account made in this browser.
      if (mode !== 'login') clearInvite();
      // Out of component state the moment it is no longer needed.
      setPassword('');
      if (session.user) gate.adopt(session.user, session.access);
    } catch (caught) {
      setError(caught instanceof AuthError ? caught.message : (caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, [displayName, email, gate, mode, password]);

  return (
    <Shell>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
        {mode === 'login' ? 'Sign in' : 'Create an account'}
      </Typography>

      <Stack
        spacing={2}
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === 'register' && (
          <TextField
            label="Name"
            size="small"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            autoComplete="name"
            fullWidth
          />
        )}
        <TextField
          label="Email"
          size="small"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          autoFocus
          required
          fullWidth
        />
        <TextField
          label="Password"
          size="small"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          helperText={mode === 'register' ? `At least ${MIN_PASSWORD_LENGTH} characters.` : ' '}
          required
          fullWidth
        />

        {error && <Alert severity="error">{error}</Alert>}
        {notice && <Alert severity="info">{notice}</Alert>}

        <Button type="submit" variant="contained" disabled={busy} fullWidth>
          {busy ? <CircularProgress size={20} /> : mode === 'login' ? 'Sign in' : 'Create account'}
        </Button>
      </Stack>

      <Divider sx={{ my: 2 }} />

      <Typography variant="body2" color="text.secondary">
        {mode === 'login' ? 'No account yet? ' : 'Already have an account? '}
        <Link
          component="button"
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
            setNotice(null);
          }}
        >
          {mode === 'login' ? 'Create one — it is free' : 'Sign in'}
        </Link>
      </Typography>

      {mode === 'login' && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          <Link
            component="button"
            type="button"
            onClick={() => {
              setError(null);
              // Answers identically whether or not the address is registered, so there is nothing
              // to branch on here and nothing to learn from it about who has an account.
              void requestPasswordReset(email).then(setNotice).catch(() => {
                setNotice('If that address has an account, a reset link is on its way.');
              });
            }}
          >
            Forgotten your password?
          </Link>
        </Typography>
      )}

      <Rules />
    </Shell>
  );
}

// ---------------------------------------------------------------------------------------------

/**
 * The line, drawn as a line.
 *
 * Places in the queue and where you are among them, which is the one thing a person waiting
 * actually needs. The seats themselves are not drawn: ten dots is ten seats stated in another
 * form, and the whole point of leaving the count out is not to state it.
 *
 * Long queues are elided in the middle rather than drawn to a hundred dots, keeping your own
 * marker and both ends visible.
 */
function QueueLine({ position, waiting }: { position: number; waiting: number }) {
  const places = Array.from({ length: waiting }, (_, i) => i + 1);
  const shown = places.length <= 12
    ? places
    : [...places.slice(0, 4), ...(position > 4 && position < places.length - 3 ? [position] : []), ...places.slice(-4)]
        .filter((value, index, all) => all.indexOf(value) === index)
        .sort((a, b) => a - b);

  const dot = (key: string, mine: boolean, label: string) => (
    <Tooltip key={key} title={label}>
      <Box
        sx={{
          width: mine ? 14 : 10,
          height: mine ? 14 : 10,
          borderRadius: '50%',
          flexShrink: 0,
          bgcolor: mine ? 'primary.main' : 'transparent',
          border: 1,
          borderColor: mine ? 'primary.main' : 'divider',
          boxShadow: mine ? (theme) => `0 0 0 3px ${theme.palette.primary.main}33` : 'none',
        }}
      />
    </Tooltip>
  );

  return (
    <Box sx={{ width: '100%' }}>
      <Stack
        direction="row"
        spacing={0.75}
        sx={{ alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 0.75 }}
      >
        {shown.map((place, index) => (
          <Box key={`place-${place}`} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            {index > 0 && shown[index - 1]! < place - 1 && (
              <Typography variant="caption" color="text.secondary">
                …
              </Typography>
            )}
            {dot(`p-${place}`, place === position, place === position ? 'You' : `Waiting, #${place}`)}
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

function Queued({ gate, access }: { gate: Gate; access: AccessStatus }) {
  const position = access.position ?? 1;

  return (
    <Shell>
      <Stack spacing={2} sx={{ py: 1, alignItems: 'center' }}>
        <HourglassEmptyIcon color="primary" sx={{ fontSize: 36 }} />
        <Typography variant="h4" sx={{ fontWeight: 700 }}>
          #{position}
        </Typography>
        <Typography variant="body2" color="text.secondary" align="center">
          {position === 1
            ? 'You are next. The moment a seat frees you will be let straight in.'
            : `There ${position - 1 === 1 ? 'is' : 'are'} ${position - 1} ahead of you.`}
        </Typography>

        {/* Why they are here, when it is not simply that they arrived. */}
        {access.lastReason === 'idle' && (
          <Alert severity="info" sx={{ width: '100%' }}>
            <AlertTitle>Your seat was passed on</AlertTitle>
            Nothing happened for two minutes, so it went to the next person waiting.
            {access.carriedMs !== null && access.carriedMs > 0 && (
              <> Your remaining {formatDuration(access.carriedMs)} is kept and resumes when you get back in.</>
            )}
          </Alert>
        )}

        <QueueLine position={position} waiting={access.waiting} />

        <Box sx={{ width: '100%' }}>
          <LinearProgress />
        </Box>

        <Typography variant="caption" color="text.secondary" align="center">
          Leave this page open; your place is held while it is. When your turn comes, be at the
          keyboard — a seat with nobody using it is passed on after two minutes.
        </Typography>

        <Button size="small" color="inherit" onClick={() => void gate.signOut()}>
          Leave the queue
        </Button>
      </Stack>
    </Shell>
  );
}

function Cooldown({ gate, access }: { gate: Gate; access: AccessStatus }) {
  const remaining = useCountdown(access.cooldownUntil);
  const over = remaining !== null && remaining <= 0;

  // Rejoin as soon as the clock runs out, without making anyone watch for the moment.
  useEffect(() => {
    if (over) void gate.join();
  }, [over, gate]);

  return (
    <Shell>
      <Stack spacing={2} sx={{ py: 1, alignItems: 'center' }}>
        <AccessTimeIcon color="warning" sx={{ fontSize: 40 }} />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Your hour is up
        </Typography>
        <Typography variant="h4" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {remaining === null ? '—' : formatDuration(remaining)}
        </Typography>
        <Typography variant="body2" color="text.secondary" align="center">
          There is a short wait between turns so everyone gets one — longer when people are
          queuing, barely anything when they are not. You will rejoin automatically when it ends,
          and if the queue clears in the meantime this gets shorter.
        </Typography>
        <Typography variant="caption" color="text.secondary" align="center">
          Your circuits are saved. Nothing is lost.
        </Typography>

        <Button size="small" color="inherit" onClick={() => void gate.signOut()}>
          Sign out
        </Button>
      </Stack>
    </Shell>
  );
}

function Idle({ gate }: { gate: Gate }) {
  const [busy, setBusy] = useState(false);

  return (
    <Shell>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
        Ready when you are
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Signed in as {gate.user?.email}. Take a seat to start building.
      </Typography>

      {gate.error && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {gate.error}
        </Alert>
      )}

      <Button
        variant="contained"
        fullWidth
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void gate.join().finally(() => setBusy(false));
        }}
      >
        {busy ? <CircularProgress size={20} /> : 'Start a session'}
      </Button>

      <Button size="small" color="inherit" sx={{ mt: 1 }} fullWidth onClick={() => void gate.signOut()}>
        Sign out
      </Button>

      <Rules />
    </Shell>
  );
}

/**
 * Signed in, address not yet proved.
 *
 * The one screen where doing nothing is the right move -- the link is in their inbox, not here --
 * so it says so plainly and offers exactly two things: send another, or use a different address by
 * signing out. Anything else would suggest there is something to do on this page.
 */
function Unverified({ gate }: { gate: Gate }) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Shell>
      <Stack spacing={2} sx={{ py: 1, alignItems: 'center' }}>
        <MarkEmailUnreadIcon color="primary" sx={{ fontSize: 36 }} />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Confirm your address
        </Typography>
        <Typography variant="body2" color="text.secondary" align="center">
          We sent a link to <strong>{gate.user?.email}</strong>. Open it and you are in — this page
          will notice on its own.
        </Typography>
        <Typography variant="caption" color="text.secondary" align="center">
          Confirming is what keeps the queue fair. Accounts are free, so without it anyone wanting a
          permanent seat would simply make ten of them.
        </Typography>

        {gate.error && (
          <Alert severity="warning" sx={{ width: '100%' }}>
            {gate.error}
          </Alert>
        )}
        {sent && !gate.error && (
          <Alert severity="success" sx={{ width: '100%' }}>
            Another link is on its way. It can take a minute — check spam if it does not appear.
          </Alert>
        )}

        <Button
          variant="outlined"
          fullWidth
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void gate
              .resend()
              .then(() => setSent(true))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <CircularProgress size={20} /> : 'Send it again'}
        </Button>

        <Button size="small" color="inherit" onClick={() => void gate.signOut()}>
          Use a different address
        </Button>
      </Stack>
    </Shell>
  );
}

function Unreachable({ gate }: { gate: Gate }) {
  return (
    <Shell>
      <Alert severity="error" icon={<CloudOffIcon />}>
        <AlertTitle>Cannot reach the account service</AlertTitle>
        An account is required to use the simulator, so there is nothing to fall back to. Start the
        service with <code>npm run service</code> and try again.
      </Alert>
      <Button variant="outlined" fullWidth sx={{ mt: 2 }} onClick={() => void gate.refresh()}>
        Try again
      </Button>
    </Shell>
  );
}

// ---------------------------------------------------------------------------------------------

/**
 * Where a verification link lands.
 *
 * Spends the token once, on mount, and then rewrites the URL to drop it. Without that, a refresh
 * replays a token that has already been used and the person is told their perfectly good link is
 * invalid -- and a spent token sitting in the address bar is a secret in browser history for no
 * reason.
 */
export function VerifyLanding({
  gate,
  token,
  onDone,
}: {
  gate: Gate;
  token: string | null;
  onDone(): void;
}) {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setState('failed');
      setMessage('That link is missing its token. Try opening it from the email again.');
      return;
    }

    let cancelled = false;
    void verifyEmail(token)
      .then((session) => {
        if (cancelled) return;
        setState('done');
        if (session.user) gate.adopt(session.user, session.access);
        // Long enough to read, short enough not to be a wait. Then out of the way: leaving the
        // landing on screen would strand a confirmed account on a page with nothing to do.
        setTimeout(() => {
          if (!cancelled) onDone();
        }, 1200);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState('failed');
        setMessage(error instanceof AuthError ? error.message : (error as Error).message);
      })
      .finally(() => {
        window.history.replaceState(null, '', '/');
      });

    return () => {
      cancelled = true;
    };
    // Deliberately once: spending the token is not something to redo when the gate object changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <Shell>
      <Stack spacing={2} sx={{ py: 1, alignItems: 'center' }}>
        {state === 'working' && <CircularProgress />}
        {state === 'done' && (
          <>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Address confirmed
            </Typography>
            <Typography variant="body2" color="text.secondary" align="center">
              That is everything. Taking you in…
            </Typography>
          </>
        )}
        {state === 'failed' && (
          <>
            <Alert severity="error" sx={{ width: '100%' }}>
              {message}
            </Alert>
            <Button
              variant="outlined"
              fullWidth
              onClick={() => {
                onDone();
                void gate.refresh();
              }}
            >
              Continue
            </Button>
          </>
        )}
      </Stack>
    </Shell>
  );
}

/** Where a password-reset link lands: choose a new one, then sign in with it. */
export function ResetLanding({
  gate,
  token,
  onDone,
}: {
  gate: Gate;
  token: string | null;
  onDone(): void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = useCallback(async () => {
    if (!token) {
      setError('That link is missing its token. Try opening it from the email again.');
      return;
    }
    // Checked here as well as on the server, because being told the two do not match after a round
    // trip that also spent the token would leave nothing to try again with.
    if (password !== confirm) {
      setError('Those two do not match.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await resetPassword(token, password);
      setPassword('');
      setConfirm('');
      setDone(true);
      window.history.replaceState(null, '', '/');
      await gate.refresh();
    } catch (caught) {
      setError(caught instanceof AuthError ? caught.message : (caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, [confirm, gate, password, token]);

  if (done) {
    return (
      <Shell>
        <Alert severity="success">
          Password changed, and every other session has been signed out. Sign in with the new one.
        </Alert>
        <Button
          variant="contained"
          fullWidth
          sx={{ mt: 2 }}
          onClick={() => {
            onDone();
            void gate.refresh();
          }}
        >
          Sign in
        </Button>
      </Shell>
    );
  }

  return (
    <Shell>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>
        Choose a new password
      </Typography>
      <Stack
        spacing={2}
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="New password"
          size="small"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          helperText={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          autoFocus
          required
          fullWidth
        />
        <TextField
          label="Again"
          size="small"
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
          required
          fullWidth
        />
        {error && <Alert severity="error">{error}</Alert>}
        <Button type="submit" variant="contained" disabled={busy} fullWidth>
          {busy ? <CircularProgress size={20} /> : 'Change it'}
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 2 }}>
        Changing your password signs out every session, on every device.
      </Typography>
    </Shell>
  );
}

export function AccessGate({ gate }: { gate: Gate }) {
  switch (gate.phase) {
    case 'loading':
      return (
        <Shell>
          <Stack sx={{ py: 3, alignItems: 'center' }}>
            <CircularProgress />
          </Stack>
        </Shell>
      );
    case 'unreachable':
      return <Unreachable gate={gate} />;
    case 'unverified':
      return <Unverified gate={gate} />;
    case 'queued':
      return <Queued gate={gate} access={gate.access!} />;
    case 'cooldown':
      return <Cooldown gate={gate} access={gate.access!} />;
    case 'idle':
      return <Idle gate={gate} />;
    default:
      return <SignIn gate={gate} />;
  }
}
