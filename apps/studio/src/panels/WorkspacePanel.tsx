/**
 * Canvas host.
 *
 * Konva needs explicit pixel dimensions, so the panel measures itself and hands the stage a size.
 * dockview resizes freely, hence the ResizeObserver rather than a one-time measurement.
 *
 * Zoom controls live here rather than inside the stage: they are DOM buttons floating over the
 * canvas, which keeps them crisp at any zoom and out of Konva's hit-testing.
 */
import {
  Box,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Tooltip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import Rotate90DegreesCwIcon from '@mui/icons-material/Rotate90DegreesCw';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Workspace, type CanvasControls } from '../canvas/Workspace.tsx';
import { useStudio } from '../store.ts';

export function WorkspacePanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const controlsRef = useRef<CanvasControls | null>(null);
  const [menu, setMenu] = useState<{ partId: string; x: number; y: number } | null>(null);
  const removePart = useStudio((s) => s.removePart);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const handleControls = useCallback((controls: CanvasControls) => {
    controlsRef.current = controls;
    // Published so the View menu can zoom too. Cleared on unmount, which is what lets those menu
    // items disable themselves when the workspace panel is closed rather than silently doing
    // nothing.
    useStudio.getState().setCanvasControls(controls);
  }, []);

  useEffect(() => () => useStudio.getState().setCanvasControls(null), []);

  const handleContextMenu = useCallback(
    (event: { partId: string; x: number; y: number }) => setMenu(event),
    [],
  );

  /** A quarter turn on the spot. Wires follow, because they are drawn from the terminal map. */
  const rotate = useCallback((partId: string) => {
    const state = useStudio.getState();
    const part = state.project.parts.find((p) => p.id === partId);
    if (part) state.rotatePart(partId, part.rotation + 90);
  }, []);

  /** Detach a part without deleting it: legs come out of the holes, the part stays on the canvas. */
  const unplug = useCallback((partId: string) => {
    const state = useStudio.getState();
    for (const wire of state.project.wires) {
      if (wire.from.startsWith(`${partId}:`) || wire.to.startsWith(`${partId}:`)) {
        state.removeWire(wire.id);
      }
    }
  }, []);

  return (
    <Box ref={containerRef} sx={{ height: '100%', width: '100%', overflow: 'hidden', position: 'relative' }}>
      {size.width > 0 && (
        <Workspace
          width={size.width}
          height={size.height}
          onControls={handleControls}
          onPartContextMenu={handleContextMenu}
        />
      )}

      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}
      >
        {/* First, because turning a part is the thing you do most often to one and the only one of
            these three that is not destructive. */}
        <MenuItem
          onClick={() => {
            if (menu) rotate(menu.partId);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <Rotate90DegreesCwIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Rotate 90°" secondary="Or press R with it selected" />
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) unplug(menu.partId);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <LinkOffIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Unplug" secondary="Remove its wires, keep the part" />
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) removePart(menu.partId);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <DeleteOutlineIcon fontSize="small" color="error" />
          </ListItemIcon>
          <ListItemText primary="Delete part" />
        </MenuItem>
      </Menu>
      <Paper
        variant="outlined"
        sx={{ position: 'absolute', right: 8, bottom: 8, p: 0.25, bgcolor: 'background.paper' }}
      >
        <Stack direction="row" spacing={0.25}>
          <Tooltip title="Zoom out">
            <IconButton onClick={() => controlsRef.current?.zoomOut()}>
              <RemoveIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Zoom in">
            <IconButton onClick={() => controlsRef.current?.zoomIn()}>
              <AddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Fit circuit to view">
            <IconButton onClick={() => controlsRef.current?.fit()}>
              <FitScreenIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Paper>

    </Box>
  );
}
