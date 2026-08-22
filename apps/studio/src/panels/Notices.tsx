/**
 * Transient feedback.
 *
 * The app had an error chip in the toolbar and nothing at all for anything that worked, which
 * leaves every successful action feeling like it might not have happened -- did the save land, did
 * the compile finish, did the paste do anything. Silence is the wrong answer to "did that work".
 *
 * Bottom left, out of the way of the canvas and the panels, and short: a message you have to
 * dismiss is a message that interrupted you.
 */
import { Alert, Snackbar } from '@mui/material';
import { useStudio } from '../store.ts';

export function Notices() {
  const notice = useStudio((s) => s.notice);
  const dismiss = useStudio((s) => s.dismissNotice);

  return (
    <Snackbar
      // Keyed on the timestamp so an identical message sent twice reopens rather than sitting
      // there looking stale.
      key={notice?.at}
      open={notice !== null}
      autoHideDuration={notice?.severity === 'error' ? 8000 : 3200}
      onClose={(_event, reason) => {
        // A click anywhere should not eat a message somebody has not read yet.
        if (reason !== 'clickaway') dismiss();
      }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
    >
      <Alert
        severity={notice?.severity ?? 'info'}
        variant="filled"
        onClose={dismiss}
        sx={{ alignItems: 'center', boxShadow: 3 }}
      >
        {notice?.message}
      </Alert>
    </Snackbar>
  );
}
