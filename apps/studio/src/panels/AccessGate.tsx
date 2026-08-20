/**
 * The gate.
 *
 * Everything in the simulator sits behind this. It is a full screen rather than a dialog because
 * that is the truth of it: there is no workspace behind the overlay to go back to, and a dialog
 * over a greyed-out canvas would suggest otherwise.
 *
 * The one rule the whole screen is built around is that people should never be surprised. The
 * queue length is on the sign-in form before a password is typed; the wait is quoted as a bound
 * that can only improve; the cooldown counts down rather than saying "later"; and the fact that
 * leaving early still costs twenty minutes is said on the button that does it, not discovered
 * afterwards.
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
import { Tooltip } from '@mui/material';
import GroupsIcon from '@mui/icons-material/Groups';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import CloudOffIcon from '@mui/icons-material/CloudOff';
import { useCallback, useEffect, useState } from 'react';
import { AuthError, login, register, type AccessStatus, type Occupancy } from '../auth.ts';
import type { AccessGate as Gate } from '../useAccess.ts';

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

/** Seats taken and people waiting. Shown before sign-in so a queue is never a surprise. */
function Occupancy({ occupancy }: { occupancy: Occupancy | null }) {
  if (!occupancy) return null;
  const full = occupancy.active >= occupancy.capacity;

  return (
    <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }}>
      <Chip
        size="small"
        icon={<GroupsIcon />}
        color={full ? 'warning' : 'success'}
        variant="outlined"
        label={`${occupancy.active} of ${occupancy.capacity} in use`}
      />
      {occupancy.waiting > 0 && (
        <Chip
          size="small"
          icon={<HourglassEmptyIcon />}
          variant="outlined"
          label={`${occupancy.waiting} waiting`}
        />
      )}
    </Stack>
  );
}

/** The rules, stated once, where someone is about to be subject to them. */
function Rules({ capacity }: { capacity: number }) {
  return (
    <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 2 }}>
      Accounts are free. {capacity} people can use the simulator at once, for an hour each;
      everyone else waits in line and is let in automatically. A seat has to be used — two minutes
      with nobody at the keyboard and it passes to the next person, though your remaining time
      comes with you. When your hour ends there is a 20-minute wait before another turn, and
      ending a session early counts the same.
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

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const session =
        mode === 'login'
          ? await login(email, password)
          : await register(email, password, displayName);
      // Out of component state the moment it is no longer needed.
      setPassword('');
      if (session.user) gate.adopt(session.user, session.access);
    } catch (caught) {
      setError(caught instanceof AuthError ? caught.message : (caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, [displayName, email, gate, mode, password]);

  const capacity = gate.occupancy?.capacity ?? 10;
  const full = (gate.occupancy?.active ?? 0) >= capacity;

  return (
    <Shell>
      <Occupancy occupancy={gate.occupancy} />

      {full && mode === 'login' && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Every seat is taken. Signing in will put you in the queue, and you will be let in
          automatically.
        </Alert>
      )}

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
          }}
        >
          {mode === 'login' ? 'Create one — it is free' : 'Sign in'}
        </Link>
      </Typography>

      <Rules capacity={capacity} />
    </Shell>
  );
}

// ---------------------------------------------------------------------------------------------

/**
 * The line, drawn as a line.
 *
 * A bare position number leaves people guessing at what it means. Seats and waiting places shown
 * as one row makes the whole situation legible at a glance: how many are in use, how many are
 * ahead, and exactly where you are among them.
 *
 * Long queues are elided in the middle rather than drawn to a hundred dots, keeping your own
 * marker and both ends visible.
 */
function QueueLine({ position, waiting, capacity, active }: {
  position: number;
  waiting: number;
  capacity: number;
  active: number;
}) {
  const seats = Array.from({ length: capacity }, (_, i) => i < active);
  const places = Array.from({ length: waiting }, (_, i) => i + 1);
  const shown = places.length <= 12
    ? places
    : [...places.slice(0, 4), ...(position > 4 && position < places.length - 3 ? [position] : []), ...places.slice(-4)]
        .filter((value, index, all) => all.indexOf(value) === index)
        .sort((a, b) => a - b);

  const dot = (key: string, filled: boolean, mine: boolean, label: string) => (
    <Tooltip key={key} title={label}>
      <Box
        sx={{
          width: mine ? 14 : 10,
          height: mine ? 14 : 10,
          borderRadius: '50%',
          flexShrink: 0,
          bgcolor: mine ? 'primary.main' : filled ? 'success.main' : 'transparent',
          border: 1,
          borderColor: mine ? 'primary.main' : filled ? 'success.main' : 'divider',
          boxShadow: mine ? (theme) => `0 0 0 3px ${theme.palette.primary.main}33` : 'none',
        }}
      />
    </Tooltip>
  );

  return (
    <Box sx={{ width: '100%' }}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
        {seats.map((filled, i) =>
          dot(`seat-${i}`, filled, false, filled ? 'Seat in use' : 'Free seat'),
        )}
        {/* Seats to the left of this, the line to the right. `'1px'` and not `1`: in MUI's
            style system a bare number between 0 and 1 is a fraction, so `width: 1` renders a
            full-width bar that pushes the queue onto its own row. */}
        <Box sx={{ width: '1px', alignSelf: 'stretch', minHeight: 16, bgcolor: 'divider', mx: 0.75 }} />
        {shown.map((place, index) => (
          <Box key={`place-${place}`} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            {index > 0 && shown[index - 1]! < place - 1 && (
              <Typography variant="caption" color="text.secondary">
                …
              </Typography>
            )}
            {dot(`p-${place}`, false, place === position, place === position ? 'You' : `Waiting, #${place}`)}
          </Box>
        ))}
      </Stack>
      <Stack direction="row" sx={{ justifyContent: 'space-between', mt: 0.75 }}>
        <Typography variant="caption" color="text.secondary">
          {active} of {capacity} seats
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {waiting} waiting
        </Typography>
      </Stack>
    </Box>
  );
}

function Queued({ gate, access }: { gate: Gate; access: AccessStatus }) {
  const position = access.position ?? 1;
  const wait = access.estimatedWaitMs;

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

        <QueueLine
          position={position}
          waiting={access.waiting}
          capacity={access.capacity}
          active={access.active}
        />

        <Box sx={{ width: '100%' }}>
          <LinearProgress />
        </Box>

        {wait !== null && wait > 0 && (
          <Typography variant="body2" color="text.secondary" align="center">
            At most <strong>{formatDuration(wait)}</strong> — sooner if someone finishes early.
          </Typography>
        )}

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
  // From the occupancy poll, not from `access`. Nothing heartbeats during a cooldown, so the
  // counts inside `access` are frozen at whatever they were when the page loaded -- which read
  // "0 of 10 in use" on a completely full server.
  const seats = gate.occupancy ?? access;
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
          There is a 20-minute wait between turns so everyone gets one. You will rejoin the queue
          automatically when it ends.
        </Typography>
        <Typography variant="caption" color="text.secondary" align="center">
          Your circuits are saved. Nothing is lost — {seats.active} of {seats.capacity} seats are
          in use right now.
        </Typography>

        <Button size="small" color="inherit" onClick={() => void gate.signOut()}>
          Sign out
        </Button>
      </Stack>
    </Shell>
  );
}

function Idle({ gate, access }: { gate: Gate; access: AccessStatus | null }) {
  const [busy, setBusy] = useState(false);
  // Live counts for the same reason as the cooldown screen: nothing is heartbeating here either.

  return (
    <Shell>
      <Occupancy occupancy={gate.occupancy ?? access} />
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

      <Rules capacity={access?.capacity ?? gate.occupancy?.capacity ?? 10} />
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
    case 'queued':
      return <Queued gate={gate} access={gate.access!} />;
    case 'cooldown':
      return <Cooldown gate={gate} access={gate.access!} />;
    case 'idle':
      return <Idle gate={gate} access={gate.access} />;
    default:
      return <SignIn gate={gate} />;
  }
}
