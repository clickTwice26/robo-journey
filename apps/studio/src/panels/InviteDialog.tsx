/**
 * Invite a friend.
 *
 * Somebody joins on your code, confirms their address, and you get credits. The wait for
 * confirmation is stated on the card rather than buried, because it is the difference between
 * "invited three people" and "been paid for three people", and a number that goes up later than
 * expected without explanation reads as a bug.
 *
 * The code is also enterable here, for people who already had an account when they were sent one.
 */
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import { useCallback, useEffect, useState } from 'react';
import { AuthError, fetchInvites, redeemInvite, type InviteState } from '../auth.ts';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <Box sx={{ flex: 1 }}>
      <Typography sx={{ fontSize: '1.7rem', fontWeight: 600, lineHeight: 1 }}>{n}</Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}

export function InviteDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [state, setState] = useState<InviteState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void fetchInvites()
      .then(setState)
      .catch((caught: unknown) =>
        setError(caught instanceof AuthError ? caught.message : (caught as Error).message),
      );
  }, [open]);

  const link = state ? `${window.location.origin}/?invite=${state.invite.code}` : '';

  const copy = useCallback(async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused. The link is on screen and selectable either way.
      setError('Could not copy. Select the link and copy it by hand.');
    }
  }, [link]);

  const redeem = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await redeemInvite(code));
      setCode('');
    } catch (caught) {
      setError(caught instanceof AuthError ? caught.message : (caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, [code]);

  const reward = state?.reward ?? 100;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Invite a friend</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
          Send them your link. When they make an account and confirm their email address, you get{' '}
          <strong>{reward} credits</strong> — enough for a good few questions to the assistant.
        </Typography>

        {state && (
          <>
            <Box
              sx={{
                mt: 2,
                p: 1.5,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1.5,
                bgcolor: 'action.hover',
              }}
            >
              <Typography variant="caption" color="text.secondary">
                Your code
              </Typography>
              <Typography sx={{ fontFamily: MONO, fontSize: '1.5rem', fontWeight: 700, letterSpacing: '0.12em' }}>
                {state.invite.code}
              </Typography>
              <Typography
                variant="caption"
                sx={{ fontFamily: MONO, color: 'text.secondary', wordBreak: 'break-all' }}
              >
                {link}
              </Typography>
            </Box>

            <Button
              fullWidth
              variant="contained"
              startIcon={copied ? <CheckIcon /> : <ContentCopyIcon />}
              onClick={() => void copy()}
              sx={{ mt: 1.5 }}
            >
              {copied ? 'Copied' : 'Copy invite link'}
            </Button>

            <Stack direction="row" sx={{ mt: 2.5, gap: 2 }}>
              <Stat n={state.invite.invited} label="joined" />
              <Stat n={state.invite.confirmed} label="confirmed" />
              <Stat n={state.invite.earned} label="credits earned" />
            </Stack>

            {state.invite.invited > state.invite.confirmed && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {state.invite.invited - state.invite.confirmed} still to confirm their address. The
                credits arrive when they do.
              </Typography>
            )}

            {!state.redeemed && (
              <>
                <Divider sx={{ my: 2.5 }} />
                <Typography variant="body2" sx={{ mb: 1 }}>
                  Been given a code?
                </Typography>
                <Stack direction="row" spacing={1}>
                  <TextField
                    size="small"
                    fullWidth
                    placeholder="ABCD2345"
                    value={code}
                    onChange={(event) => setCode(event.target.value.toUpperCase())}
                    slotProps={{ input: { sx: { fontFamily: MONO, letterSpacing: '0.1em' } } }}
                  />
                  <Button variant="outlined" disabled={busy || !code.trim()} onClick={() => void redeem()}>
                    Use it
                  </Button>
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                  Their reward arrives once your address is confirmed. One code per account.
                </Typography>
              </>
            )}
          </>
        )}

        {error && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
