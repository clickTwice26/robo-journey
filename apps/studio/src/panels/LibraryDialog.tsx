/**
 * The library: prebuilt projects to open, copy or take apart.
 *
 * Grouped rather than listed, and browsed in a dialog rather than hidden in a menu, because a flat
 * list of thirty circuits in a File menu is a list nobody reads. The groups are the order someone
 * actually meets this material -- get a pin to do something, read something, drive something --
 * so choosing one is a matter of knowing which of those you are trying to do.
 *
 * Every project replaces what is open, so the dialog says so before you click rather than after.
 */
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { LIBRARY, type LibraryProject } from '@robo-journey/parts';
import { useStudio } from '../store.ts';

export function LibraryDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [groupId, setGroupId] = useState(LIBRARY[0]!.id);
  const group = LIBRARY.find((g) => g.id === groupId) ?? LIBRARY[0]!;

  const openProject = (project: LibraryProject) => {
    useStudio.getState().loadProject(project.build());
    // The compile state belongs to the project that just went away; leaving it would report the
    // previous sketch's diagnostics against this one.
    useStudio.getState().setCompile('idle', [], null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Library</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Stack direction="row" sx={{ minHeight: 420 }}>
          {/* Groups. Narrow and fixed, so the eye goes to the projects. */}
          <Box sx={{ width: 190, borderRight: 1, borderColor: 'divider', flexShrink: 0 }}>
            <List dense disablePadding>
              {LIBRARY.map((entry) => (
                <ListItemButton
                  key={entry.id}
                  selected={entry.id === group.id}
                  onClick={() => setGroupId(entry.id)}
                >
                  <ListItemText
                    primary={entry.name}
                    secondary={`${entry.projects.length} project${entry.projects.length === 1 ? '' : 's'}`}
                  />
                </ListItemButton>
              ))}
            </List>
          </Box>

          <Box sx={{ flex: 1, overflow: 'auto' }}>
            <Box sx={{ px: 2, pt: 2, pb: 1 }}>
              <Typography variant="body2" color="text.secondary">
                {group.description}
              </Typography>
            </Box>
            <List dense disablePadding>
              {group.projects.map((project) => (
                <ListItemButton key={project.id} onClick={() => openProject(project)} sx={{ px: 2 }}>
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {project.name}
                        </Typography>
                        <Chip size="small" variant="outlined" label={project.id} sx={{ height: 18 }} />
                      </Stack>
                    }
                    secondary={project.description}
                  />
                </ListItemButton>
              ))}
            </List>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between', px: 2 }}>
        <Typography variant="caption" color="text.secondary">
          Opening a project replaces what is on the canvas. Your current work stays in the local
          autosave.
        </Typography>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
