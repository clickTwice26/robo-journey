/**
 * Projects stored on the account.
 *
 * Opening one replaces the current document, so the dialog says what is about to be lost rather
 * than discovering it afterwards. The local autosave still holds whatever was open, but a user
 * should not have to know that to feel safe clicking.
 */
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import { useCallback, useEffect, useState } from 'react';
import { parseProject } from '@robo-journey/parts';
import {
  createProject,
  deleteProject,
  listProjects,
  loadProject,
  type ProjectSummary,
} from '../auth.ts';
import { useStudio } from '../store.ts';

interface Props {
  open: boolean;
  onClose(): void;
}

/** Relative time, because "2 hours ago" is what people want from a save list. */
function relative(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function CloudProjectsDialog({ open, onClose }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cloudProjectId = useStudio((s) => s.cloudProjectId);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setProjects(await listProjects());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const open_ = useCallback(
    async (summary: ProjectSummary) => {
      setBusy(true);
      setError(null);
      try {
        const loaded = await loadProject(summary.id);
        const store = useStudio.getState();
        store.loadProject(parseProject(loaded.document));
        store.setCloudProject(summary.id);
        // A different circuit may not match the firmware currently loaded.
        store.setCompile('idle', [], null);
        onClose();
      } catch (caught) {
        setError((caught as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [onClose],
  );

  const saveCurrentAsNew = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const store = useStudio.getState();
      const created = await createProject(store.project.name, store.project);
      store.setCloudProject(created.id);
      store.setSyncState(new Date(), null);
      await refresh();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const remove = useCallback(
    async (summary: ProjectSummary) => {
      setBusy(true);
      try {
        await deleteProject(summary.id);
        // If the open document was that project, it is now local-only rather than silently
        // pointing at something that no longer exists.
        if (useStudio.getState().cloudProjectId === summary.id) {
          useStudio.getState().setCloudProject(null);
        }
        await refresh();
      } catch (caught) {
        setError((caught as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Your projects</DialogTitle>

      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {busy && projects.length === 0 && (
          <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}>
            <CircularProgress size={16} />
            <Typography variant="body2">Loading…</Typography>
          </Stack>
        )}

        {!busy && projects.length === 0 && !error && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            Nothing saved to your account yet. Save the open circuit to start.
          </Typography>
        )}

        <List dense>
          {projects.map((project) => (
            <ListItem
              key={project.id}
              disablePadding
              secondaryAction={
                <Tooltip title="Delete from your account">
                  <IconButton edge="end" onClick={() => void remove(project)} disabled={busy}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              }
            >
              <ListItemButton onClick={() => void open_(project)} disabled={busy}>
                <ListItemText
                  primary={project.name}
                  secondary={
                    project.id === cloudProjectId
                      ? `open now · saved ${relative(project.updatedAt)}`
                      : `saved ${relative(project.updatedAt)}`
                  }
                  slotProps={{ primary: { variant: 'body2' }, secondary: { variant: 'caption' } }}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button startIcon={<CloudUploadIcon />} onClick={() => void saveCurrentAsNew()} disabled={busy}>
          Save open circuit as new
        </Button>
      </DialogActions>
    </Dialog>
  );
}
