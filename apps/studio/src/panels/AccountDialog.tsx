/**
 * Sign in and registration.
 *
 * One dialog with two modes rather than two screens, because they differ by a single field and
 * people arrive at the wrong one constantly.
 *
 * Deliberately not a gate. Everything works signed out -- the circuit autosaves locally either way
 * -- and an account exists to sync across machines. Locking a local simulator behind a login would
 * be user-hostile, and the service might not even be running.
 */
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useState } from 'react';
import { AuthError, login, register, type User } from '../auth.ts';

/** Mirrors the server's minimum, so the hint is shown before a round trip rejects it. */
const MIN_PASSWORD_LENGTH = 10;

interface Props {
  open: boolean;
  onClose(): void;
  onSignedIn(user: User): void;
}

export function AccountDialog({ open, onClose, onSignedIn }: Props) {
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
      const user =
        mode === 'login'
          ? await login(email, password)
          : await register(email, password, displayName);
      // Clear the password from component state the moment it is no longer needed.
      setPassword('');
      onSignedIn(user);
      onClose();
    } catch (caught) {
      setError(caught instanceof AuthError ? caught.message : (caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, [mode, email, password, displayName, onSignedIn, onClose]);

  const passwordTooShort = mode === 'register' && password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const canSubmit = !busy && email.includes('@') && password.length > 0 && !passwordTooShort;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{mode === 'login' ? 'Sign in' : 'Create an account'}</DialogTitle>

      <DialogContent dividers>
        <Stack
          component="form"
          spacing={2}
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          <Typography variant="body2" color="text.secondary">
            An account syncs your circuits across machines. Everything works without one — your
            work is saved in this browser either way.
          </Typography>

          {mode === 'register' && (
            <TextField
              label="Name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
              fullWidth
            />
          )}

          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
            fullWidth
          />

          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            // Tells a password manager which flow this is, so it offers to save on registration
            // and to fill on sign-in.
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            error={passwordTooShort}
            helperText={
              mode === 'register'
                ? `At least ${MIN_PASSWORD_LENGTH} characters. A memorable phrase beats a short jumble.`
                : undefined
            }
            fullWidth
          />

          {error && <Alert severity="error">{error}</Alert>}

          {/* Submit lives here too, so Enter works inside the form. */}
          <Box component="button" type="submit" sx={{ display: 'none' }} />
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
            {mode === 'login' ? 'Create one' : 'Sign in'}
          </Link>
        </Typography>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => void submit()}
          disabled={!canSubmit}
          startIcon={busy ? <CircularProgress size={14} /> : undefined}
        >
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
