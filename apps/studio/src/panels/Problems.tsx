/**
 * Problems panel.
 *
 * The feature the whole project exists for. Every entry carries the measured number that made it a
 * problem, because "check your wiring" helps nobody and "D13 is passing 93.3 mA" tells you exactly
 * what to change.
 */
import {
  Alert,
  AlertTitle,
  Box,
  Chip,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import { useStudio } from '../store.ts';

export function ProblemsPanel() {
  const faults = useStudio((s) => s.snapshot.faults);
  const problems = useStudio((s) => s.snapshot.problems);
  const diagnostics = useStudio((s) => s.diagnostics);
  const buildError = useStudio((s) => s.buildError);

  const empty =
    faults.length === 0 && problems.length === 0 && diagnostics.length === 0 && !buildError;

  if (empty) {
    return (
      <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: 'center', color: 'text.secondary' }}>
        <CheckCircleOutlineIcon fontSize="small" color="success" />
        <Typography variant="body2">
          No problems. The circuit is electrically sound and the sketch compiles.
        </Typography>
      </Stack>
    );
  }

  return (
    <Box sx={{ height: '100%', overflow: 'auto' }}>
      {buildError && (
        <Alert severity="error" variant="outlined" sx={{ m: 1 }}>
          <AlertTitle>Build system unavailable</AlertTitle>
          <Box component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>
            {buildError}
          </Box>
        </Alert>
      )}
      <List dense disablePadding>
        {diagnostics.map((d, i) => (
          <ListItem key={`d${i}`} sx={{ alignItems: 'flex-start' }}>
            <Box sx={{ pt: 0.4, pr: 1 }}>
              {d.severity === 'error' ? (
                <ErrorOutlineIcon fontSize="small" color="error" />
              ) : (
                <WarningAmberIcon fontSize="small" color="warning" />
              )}
            </Box>
            <ListItemText
              primary={d.message}
              secondary={`${d.file}:${d.line}${d.column ? `:${d.column}` : ''}`}
              slotProps={{ primary: { variant: 'body2' }, secondary: { variant: 'caption' } }}
            />
          </ListItem>
        ))}

        {faults.map((fault, i) => (
          <ListItem key={`f${i}`} sx={{ alignItems: 'flex-start' }}>
            <Box sx={{ pt: 0.4, pr: 1 }}>
              {fault.severity === 'error' ? (
                <ErrorOutlineIcon fontSize="small" color="error" />
              ) : (
                <WarningAmberIcon fontSize="small" color="warning" />
              )}
            </Box>
            <ListItemText
              primary={fault.message}
              secondary={
                <Stack direction="row" spacing={0.5} component="span" sx={{ mt: 0.3 }}>
                  <Chip label={fault.subject} size="small" variant="outlined" />
                  <Chip label={fault.code} size="small" variant="outlined" />
                  <Chip label={`t = ${fault.time.toFixed(3)} s`} size="small" variant="outlined" />
                </Stack>
              }
              slotProps={{ primary: { variant: 'body2' } }}
            />
          </ListItem>
        ))}

        {problems.map((problem, i) => (
          <ListItem key={`p${i}`}>
            <Box sx={{ pt: 0.4, pr: 1 }}>
              <WarningAmberIcon fontSize="small" color="warning" />
            </Box>
            <ListItemText primary={problem} slotProps={{ primary: { variant: 'body2' } }} />
          </ListItem>
        ))}
      </List>
    </Box>
  );
}
