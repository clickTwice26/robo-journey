/**
 * Opening a project, from wherever it is.
 *
 * One dialog for both sources on purpose. "Open" is a single intention, and splitting it -- a file
 * picker behind File > Open, a saved list behind the account menu -- makes someone decide where
 * their circuit is before they can go and look for it. They frequently do not remember.
 *
 * Opening replaces the current document, so the dialog says what is about to happen rather than
 * letting it be discovered afterwards. The local autosave still holds whatever was open, but
 * nobody should have to know that to feel safe clicking.
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
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Divider } from '@mui/material';
import { parseProject } from '@robo-journey/parts';
import {
  createProject,
  deleteProject,
  listProjects,
  loadProject,
  type ProjectSummary,
} from '../auth.ts';
import { deserializeProject, PROJECT_EXTENSION } from '../projectFile.ts';
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
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cloudProjectId = useStudio((s) => s.cloudProjectId);
  const signedIn = useStudio((s) => s.user) !== null;

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

  /**
   * Take a project from a file the user chose or dropped.
   *
   * Shared by the button and the drop target so both behave identically -- including the failure,
   * which has to name the file. "Could not read that" about an unnamed file, when three were
   * dropped, is not something anyone can act on.
   */
  const openFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const project = deserializeProject(await file.text());
        const store = useStudio.getState();
        store.loadProject(project);
        // Opened from a file, so it is not the account's copy of anything: saving should ask where
        // to put it rather than quietly overwriting whatever was last open from the cloud.
        store.setCloudProject(null);
        store.setCompile('idle', [], null);
        onClose();
      } catch (caught) {
        setError(`${file.name}: ${(caught as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [onClose],
  );

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
      <DialogTitle>Open a project</DialogTitle>

      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* A drop target as well as a button. Someone with a .rjp file in a folder reaches for
            drag before they reach for a file picker, and the two cost the same to support. */}
        <Box
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void openFile(file);
          }}
          sx={{
            mb: 2,
            p: 2,
            border: 1,
            borderStyle: 'dashed',
            borderColor: dragging ? 'primary.main' : 'divider',
            borderRadius: 1,
            textAlign: 'center',
            bgcolor: dragging ? 'action.hover' : 'transparent',
            transition: 'background-color 120ms, border-color 120ms',
          }}
        >
          <UploadFileIcon fontSize="small" color={dragging ? 'primary' : 'disabled'} />
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Drop a <code>{PROJECT_EXTENSION}</code> file here
          </Typography>
          <Button
            size="small"
            startIcon={<FolderOpenIcon />}
            sx={{ mt: 1 }}
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            Choose a file
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept={`${PROJECT_EXTENSION},application/json`}
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so choosing the same file twice in a row still fires a change event.
              event.target.value = '';
              if (file) void openFile(file);
            }}
          />
        </Box>

        <Divider sx={{ mb: 1 }}>
          <Typography variant="caption" color="text.secondary">
            or from your account
          </Typography>
        </Divider>

        {!signedIn && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            Sign in to keep projects on your account and reach them from any machine.
          </Typography>
        )}

        {busy && projects.length === 0 && (
          <Stack direction="row" spacing={1} sx={{ p: 2, alignItems: 'center' }}>
            <CircularProgress size={16} />
            <Typography variant="body2">Loading…</Typography>
          </Stack>
        )}

        {!busy && signedIn && projects.length === 0 && !error && (
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
                <CloudDoneIcon
                  fontSize="small"
                  sx={{ mr: 1.5, color: project.id === cloudProjectId ? 'success.main' : 'text.disabled' }}
                />
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
