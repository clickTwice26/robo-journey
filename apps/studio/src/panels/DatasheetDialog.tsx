/**
 * Add a component from its datasheet.
 *
 * The dialog's real job is not the extraction -- that happens on the service -- but making the
 * result honest. A generated component is presented with its assumptions listed, its confidence
 * shown, and an explicit "unverified" badge that stays until a human checks it. A simulator whose
 * whole premise is that the numbers are real cannot quietly absorb numbers a model guessed.
 */
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  List,
  ListItem,
  ListItemText,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  manifestToPartDefinition,
  parseManifest,
  registerPart,
  type ComponentManifest,
} from '@robo-journey/parts';
import { datasheetStatus, extractComponent, type ExtractIssue } from '../api.ts';

interface Props {
  open: boolean;
  onClose(): void;
  onAdded(manifest: ComponentManifest): void;
}

export function DatasheetDialog({ open, onClose, onAdded }: Props) {
  const [mode, setMode] = useState<'text' | 'pdf'>('text');
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const [pdf, setPdf] = useState<{ name: string; base64: string; bytes: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<ComponentManifest | null>(null);
  const [issues, setIssues] = useState<ExtractIssue[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    void datasheetStatus().then((s) => setConfigured(s.configured));
  }, [open]);

  const reset = useCallback(() => {
    setManifest(null);
    setIssues([]);
    setError(null);
  }, []);

  const pickFile = useCallback(async (file: File) => {
    const buffer = await file.arrayBuffer();
    // btoa needs a binary string; chunked to avoid blowing the argument limit on a few-MB PDF.
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    setPdf({ name: file.name, base64: btoa(binary), bytes: bytes.length });
    reset();
  }, [reset]);

  const extract = useCallback(async () => {
    setBusy(true);
    reset();
    try {
      const result = await extractComponent({
        ...(mode === 'pdf' && pdf ? { pdfBase64: pdf.base64 } : { text }),
        ...(hint ? { hint } : {}),
      });

      if (!result.ok || !result.manifest) {
        setError(result.error ?? 'Extraction produced no usable manifest.');
        return;
      }
      setManifest(parseManifest(result.manifest));
      setIssues(result.issues ?? []);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, [mode, pdf, text, hint, reset]);

  const add = useCallback(() => {
    if (!manifest) return;
    try {
      registerPart(manifestToPartDefinition(manifest));
      onAdded(manifest);
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [manifest, onAdded, onClose]);

  const canExtract = !busy && (mode === 'text' ? text.trim().length > 40 : pdf !== null);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AutoAwesomeIcon fontSize="small" color="primary" />
        Add a component from its datasheet
      </DialogTitle>

      <DialogContent dividers>
        {configured === false && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>Extraction is not configured</AlertTitle>
            Set <code>GEMINI_API_KEY</code> in the project&apos;s <code>.env</code> and restart the
            compile service. The key stays on the service — it is never sent to the browser.
          </Alert>
        )}

        <Tabs value={mode} onChange={(_, value) => setMode(value as 'text' | 'pdf')} sx={{ mb: 2 }}>
          <Tab label="Paste text" value="text" />
          <Tab label="Upload PDF" value="pdf" />
        </Tabs>

        {mode === 'text' ? (
          <TextField
            fullWidth
            multiline
            minRows={8}
            maxRows={16}
            label="Datasheet text"
            placeholder="Paste the electrical characteristics, pin table and timing sections."
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              reset();
            }}
          />
        ) : (
          <Stack spacing={1}>
            <Button
              variant="outlined"
              startIcon={<UploadFileIcon />}
              onClick={() => fileRef.current?.click()}
            >
              {pdf ? `${pdf.name} (${Math.round(pdf.bytes / 1024)} KB)` : 'Choose a PDF datasheet'}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void pickFile(file);
              }}
            />
            <Typography variant="caption" color="text.secondary">
              PDFs are read directly, which matters: a datasheet&apos;s meaning lives in its tables
              and pin drawings, and flattening it to text loses exactly the parts worth extracting.
            </Typography>
          </Stack>
        )}

        <TextField
          fullWidth
          size="small"
          label="Hint (optional)"
          placeholder="e.g. HC-SR04 ultrasonic rangefinder"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          sx={{ mt: 2 }}
        />

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            <Box component="pre" sx={{ m: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>
              {error}
            </Box>
          </Alert>
        )}

        {manifest && <ManifestPreview manifest={manifest} issues={issues} />}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          onClick={extract}
          disabled={!canExtract || configured === false}
          startIcon={busy ? <CircularProgress size={14} /> : <AutoAwesomeIcon />}
        >
          {manifest ? 'Extract again' : 'Extract'}
        </Button>
        <Button variant="contained" onClick={add} disabled={!manifest}>
          Add to palette
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ManifestPreview({
  manifest,
  issues,
}: {
  manifest: ComponentManifest;
  issues: ExtractIssue[];
}) {
  const warnings = issues.filter((i) => i.severity === 'warning');

  return (
    <Box sx={{ mt: 2 }}>
      <Divider sx={{ mb: 2 }} />

      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', mb: 1, gap: 0.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mr: 1 }}>
          {manifest.name}
        </Typography>
        {/* The badge that must not go away until a human checks the numbers. */}
        <Chip size="small" color="warning" label="AI-generated · unverified" />
        <Chip size="small" variant="outlined" label={manifest.behavior.kind} />
        <Chip size="small" variant="outlined" label={`${manifest.pins.length} pins`} />
        {manifest.provenance.confidence !== undefined && (
          <Chip
            size="small"
            variant="outlined"
            color={manifest.provenance.confidence >= 0.7 ? 'success' : 'warning'}
            label={`confidence ${(manifest.provenance.confidence * 100).toFixed(0)}%`}
          />
        )}
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {manifest.description}
      </Typography>

      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5, mb: 2 }}>
        {manifest.pins.map((pin) => (
          <Chip
            key={pin.name}
            size="small"
            variant="outlined"
            label={`${pin.name} · ${pin.model.kind}`}
            sx={{ fontFamily: 'ui-monospace, monospace' }}
          />
        ))}
      </Stack>

      {manifest.state.length > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>Simulated inputs</AlertTitle>
          {manifest.state.map((variable) => (
            <Typography key={variable.name} variant="body2">
              {variable.label}: {variable.min}–{variable.max} {variable.unit} (default{' '}
              {variable.default})
            </Typography>
          ))}
        </Alert>
      )}

      {manifest.provenance.unresolved.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>
            {manifest.provenance.unresolved.length} value
            {manifest.provenance.unresolved.length === 1 ? '' : 's'} the datasheet did not give
          </AlertTitle>
          <Typography variant="caption" color="text.secondary">
            These were assumed. Check them against the datasheet before trusting a simulation that
            depends on them.
          </Typography>
          <List dense disablePadding sx={{ mt: 0.5 }}>
            {manifest.provenance.unresolved.map((item, i) => (
              <ListItem key={i} disableGutters sx={{ py: 0 }}>
                <ListItemText primary={item} slotProps={{ primary: { variant: 'body2' } }} />
              </ListItem>
            ))}
          </List>
        </Alert>
      )}

      {warnings.length > 0 && (
        <Alert severity="warning">
          <AlertTitle>Validation warnings</AlertTitle>
          <List dense disablePadding>
            {warnings.map((issue, i) => (
              <ListItem key={i} disableGutters sx={{ py: 0 }}>
                <ListItemText
                  primary={issue.message}
                  secondary={issue.path}
                  slotProps={{ primary: { variant: 'body2' }, secondary: { variant: 'caption' } }}
                />
              </ListItem>
            ))}
          </List>
        </Alert>
      )}
    </Box>
  );
}
