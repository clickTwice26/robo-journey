/**
 * Canvas host.
 *
 * Konva needs explicit pixel dimensions, so the panel measures itself and hands the stage a size.
 * dockview resizes freely, hence the ResizeObserver rather than a one-time measurement.
 *
 * Zoom controls live here rather than inside the stage: they are DOM buttons floating over the
 * canvas, which keeps them crisp at any zoom and out of Konva's hit-testing.
 */
import { Box, IconButton, Paper, Stack, Tooltip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Workspace, type CanvasControls } from '../canvas/Workspace.tsx';

export function WorkspacePanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const controlsRef = useRef<CanvasControls | null>(null);

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
  }, []);

  return (
    <Box ref={containerRef} sx={{ height: '100%', width: '100%', overflow: 'hidden', position: 'relative' }}>
      {size.width > 0 && (
        <Workspace width={size.width} height={size.height} onControls={handleControls} />
      )}
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
