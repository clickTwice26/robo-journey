/**
 * Toolbar and status bar.
 *
 * Compile, run, pause, step, reset -- plus the numbers that tell you the simulation is honest:
 * simulated time, cycle count, and how fast it is running against the wall clock.
 */
import {
  AppBar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Toolbar as MuiToolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import BuildIcon from '@mui/icons-material/Build';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { useCallback, useState } from 'react';
import { EXAMPLES } from '@robo-journey/parts';
import { compileSketch, CompileUnavailableError } from './api.ts';
import { useStudio } from './store.ts';
import type { SimulationController } from './sim/useSimulation.ts';

export function Toolbar({ sim }: { sim: SimulationController }) {
  const project = useStudio((s) => s.project);
  const snapshot = useStudio((s) => s.snapshot);
  const compileStatus = useStudio((s) => s.compileStatus);
  const hex = useStudio((s) => s.hex);
  const setCompile = useStudio((s) => s.setCompile);
  const setBuildError = useStudio((s) => s.setBuildError);
  const setProject = useStudio((s) => s.setProject);
  const [examplesAnchor, setExamplesAnchor] = useState<HTMLElement | null>(null);

  const build = useCallback(async () => {
    setCompile('compiling', [], null);
    try {
      const result = await compileSketch(project.sketch);
      setCompile(result.ok ? 'ok' : 'error', result.diagnostics, result.hex ?? null);
      if (result.ok && result.hex) sim.load(project, result.hex);
    } catch (error) {
      // Environment failures go to `buildError`, never to a marker on a line of valid code.
      setBuildError(
        error instanceof CompileUnavailableError
          ? error.message
          : (error as Error).message,
      );
    }
  }, [project, setCompile, setBuildError, sim]);

  const buildAndRun = useCallback(async () => {
    await build();
    // `build` has already pushed the firmware into the worker if it succeeded.
    if (useStudio.getState().compileStatus === 'ok') sim.start();
  }, [build, sim]);

  const canRun = hex !== null;

  return (
    <AppBar position="static" color="transparent" sx={{ borderBottom: 1, borderColor: 'divider' }}>
      <MuiToolbar variant="dense" sx={{ gap: 1, minHeight: 44 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mr: 1 }}>
          robo-journey
        </Typography>

        <Button
          startIcon={<FolderOpenIcon />}
          onClick={(e) => setExamplesAnchor(e.currentTarget)}
        >
          Examples
        </Button>
        <Menu
          anchorEl={examplesAnchor}
          open={examplesAnchor !== null}
          onClose={() => setExamplesAnchor(null)}
        >
          {EXAMPLES.map((example) => (
            <MenuItem
              key={example.id}
              onClick={() => {
                setProject(example.build());
                // A new circuit invalidates the loaded firmware: its sketch may differ.
                setCompile('idle', [], null);
                setExamplesAnchor(null);
              }}
              sx={{ maxWidth: 420 }}
            >
              <ListItemText
                primary={example.name}
                secondary={example.description}
                slotProps={{ secondary: { sx: { whiteSpace: 'normal' } } }}
              />
            </MenuItem>
          ))}
        </Menu>

        <Button
          startIcon={compileStatus === 'compiling' ? <CircularProgress size={14} /> : <BuildIcon />}
          onClick={build}
          disabled={compileStatus === 'compiling'}
          variant="outlined"
        >
          Compile
        </Button>

        {snapshot.running ? (
          <Button startIcon={<PauseIcon />} onClick={sim.pause} variant="contained">
            Pause
          </Button>
        ) : (
          <Button
            startIcon={<PlayArrowIcon />}
            onClick={canRun ? sim.start : buildAndRun}
            variant="contained"
            disabled={compileStatus === 'compiling'}
          >
            {canRun ? 'Run' : 'Build & Run'}
          </Button>
        )}

        <Tooltip title="Advance 10 ms of simulated time">
          <span>
            <Button startIcon={<SkipNextIcon />} onClick={() => sim.stepTime(0.01)} disabled={!canRun}>
              Step
            </Button>
          </span>
        </Tooltip>

        <Button startIcon={<RestartAltIcon />} onClick={sim.reset} disabled={!canRun}>
          Reset
        </Button>

        <Divider orientation="vertical" flexItem sx={{ mx: 1 }} />

        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Chip
            size="small"
            variant="outlined"
            label={`t = ${snapshot.time.toFixed(3)} s`}
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          />
          <Chip
            size="small"
            variant="outlined"
            label={`${snapshot.cycles.toLocaleString()} cycles`}
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          />
          <Tooltip title="Simulated time per wall-clock second. Below 1.0 means the circuit is too heavy to run live.">
            <Chip
              size="small"
              variant="outlined"
              color={snapshot.realtimeRatio >= 1 ? 'success' : snapshot.running ? 'warning' : 'default'}
              label={`${snapshot.realtimeRatio.toFixed(2)}x realtime`}
              sx={{ fontVariantNumeric: 'tabular-nums' }}
            />
          </Tooltip>
        </Stack>

        <Box sx={{ flex: 1 }} />

        {snapshot.faults.length > 0 && (
          <Chip
            size="small"
            color={snapshot.faults.some((f) => f.severity === 'error') ? 'error' : 'warning'}
            label={`${snapshot.faults.length} problem${snapshot.faults.length === 1 ? '' : 's'}`}
          />
        )}
      </MuiToolbar>
    </AppBar>
  );
}
