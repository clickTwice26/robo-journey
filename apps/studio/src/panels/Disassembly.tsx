/**
 * Disassembly listing.
 *
 * Byte addresses throughout, matching avr-objdump, because the AVR's two address conventions --
 * the program counter counts 16-bit words, every listing counts bytes -- are the classic source of
 * off-by-two confusion when comparing against real tooling.
 *
 * Virtualised: 32 KiB of flash is around sixteen thousand instructions, and rendering that as DOM
 * nodes would cost more than the simulation.
 */
import {
  Box,
  Button,
  Chip,
  Divider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CircleIcon from '@mui/icons-material/Circle';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DisasmLine } from '@robo-journey/sim-core';
import { useStudio } from '../store.ts';
import type { SimulationController } from '../sim/useSimulation.ts';

/**
 * How much flash to list.
 *
 * A compiled Blink is under a kilobyte; 8 KiB covers anything the examples produce while keeping
 * the initial decode instant. The listing is linear from 0 so it cannot drift out of phase by
 * starting inside a 32-bit instruction.
 */
const LISTING_BYTES = 8192;
const ROW_HEIGHT = 20;

const hex = (value: number, digits = 4): string =>
  value.toString(16).toUpperCase().padStart(digits, '0');

export function DisassemblyPanel({ sim }: { sim: SimulationController }) {
  const hexImage = useStudio((s) => s.hex);
  const stoppedAt = useStudio((s) => s.snapshot.stoppedAt);
  const running = useStudio((s) => s.snapshot.running);

  const [lines, setLines] = useState<DisasmLine[]>([]);
  const [breakpoints, setBreakpoints] = useState<number[]>([]);
  const [pc, setPc] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Re-decode whenever new firmware is loaded. The listing belongs to the sketch, not the circuit.
  useEffect(() => {
    let cancelled = false;
    void sim.disassembly(0, LISTING_BYTES).then((decoded) => {
      if (!cancelled) setLines(decoded);
    });
    return () => {
      cancelled = true;
    };
  }, [sim, hexImage]);

  // Track the program counter while paused; polling it at speed would be unreadable anyway.
  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      const [state, points] = await Promise.all([sim.mcuState(), sim.breakpoints()]);
      if (cancelled) return;
      setPc(state.pc);
      setBreakpoints(points);
    };
    void pull();
    const timer = setInterval(() => void pull(), running ? 500 : 150);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sim, running, stoppedAt]);

  const index = useMemo(() => {
    const map = new Map<number, number>();
    lines.forEach((line, i) => map.set(line.address, i));
    return map;
  }, [lines]);

  const breakpointSet = useMemo(() => new Set(breakpoints), [breakpoints]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const revealPc = useCallback(() => {
    if (pc === null) return;
    const row = index.get(pc);
    if (row !== undefined) virtualizer.scrollToIndex(row, { align: 'center' });
  }, [pc, index, virtualizer]);

  // Follow the program counter automatically whenever execution stops at a breakpoint.
  useEffect(() => {
    if (stoppedAt !== null) revealPc();
  }, [stoppedAt, revealPc]);

  const toggle = useCallback(
    (address: number) => {
      if (breakpointSet.has(address)) {
        sim.clearBreakpoint(address);
        setBreakpoints((current) => current.filter((a) => a !== address));
      } else {
        sim.setBreakpoint(address);
        setBreakpoints((current) => [...current, address]);
      }
    },
    [sim, breakpointSet],
  );

  if (!hexImage) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
        Compile a sketch to see its disassembly.
      </Typography>
    );
  }

  return (
    <Stack sx={{ height: '100%' }}>
      <Stack direction="row" spacing={1} sx={{ p: 0.75, alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip size="small" variant="outlined" label={`PC 0x${hex(pc ?? 0)}`} />
        {stoppedAt !== null && (
          <Chip size="small" color="warning" label={`stopped at 0x${hex(stoppedAt)}`} />
        )}
        <Button size="small" onClick={revealPc} disabled={pc === null}>
          Show PC
        </Button>
        <Button
          size="small"
          onClick={() => {
            sim.clearBreakpoints();
            setBreakpoints([]);
          }}
          disabled={breakpoints.length === 0}
        >
          Clear {breakpoints.length || ''} breakpoint{breakpoints.length === 1 ? '' : 's'}
        </Button>
        <Typography variant="caption" color="text.secondary">
          Click the gutter to toggle a breakpoint
        </Typography>
      </Stack>

      <Divider />

      <Box ref={scrollRef} sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <Box sx={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((row) => {
            const line = lines[row.index]!;
            const isPc = pc === line.address;
            const hasBreakpoint = breakpointSet.has(line.address);

            return (
              <Box
                key={line.address}
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT,
                  transform: `translateY(${row.start}px)`,
                  display: 'flex',
                  alignItems: 'center',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 11.5,
                  bgcolor: isPc ? 'rgba(77,163,255,0.18)' : 'transparent',
                  borderLeft: isPc ? '2px solid' : '2px solid transparent',
                  borderColor: isPc ? 'primary.main' : 'transparent',
                  '&:hover': { bgcolor: isPc ? 'rgba(77,163,255,0.24)' : 'action.hover' },
                }}
              >
                <Tooltip title={hasBreakpoint ? 'Remove breakpoint' : 'Set breakpoint'}>
                  <Box
                    onClick={() => toggle(line.address)}
                    sx={{
                      width: 22,
                      display: 'flex',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    <CircleIcon
                      sx={{
                        fontSize: 9,
                        color: hasBreakpoint ? 'error.main' : 'transparent',
                        '&:hover': { color: hasBreakpoint ? 'error.main' : 'action.disabled' },
                      }}
                    />
                  </Box>
                </Tooltip>

                <Box sx={{ width: 54, color: 'text.secondary', flexShrink: 0 }}>
                  {hex(line.address)}:
                </Box>
                <Box sx={{ width: 88, color: 'text.disabled', flexShrink: 0 }}>
                  {line.words.map((w) => hex(w)).join(' ')}
                </Box>
                <Box sx={{ width: 58, color: 'primary.light', flexShrink: 0 }}>{line.mnemonic}</Box>
                <Box sx={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden' }}>
                  {line.operands}
                  {line.comment && (
                    <Box component="span" sx={{ color: 'success.light', ml: 1 }}>
                      ; {line.comment}
                    </Box>
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>
    </Stack>
  );
}
