/**
 * Oscilloscope and logic analyser.
 *
 * uPlot draws the traces: it is the fastest Canvas2D time-series plotter available and it renders
 * a hundred thousand points without breaking a frame, which matters because a serial capture at
 * 9600 baud produces edges faster than any DOM-based chart could keep up with.
 *
 * Digital channels are drawn stacked and offset rather than overlaid, the way a logic analyser
 * shows them -- overlaying twenty logic lines on one axis is unreadable, and the whole point is to
 * see which line moved first.
 */
import {
  Box,
  Chip,
  Divider,
  FormControlLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useTheme } from '@mui/material/styles';
import { scopeChrome, scopeTraceColors } from '../theme.ts';
import { useStudio } from '../store.ts';
import type { DecodedFrame, TraceData } from '../sim/protocol.ts';
import type { SimulationController } from '../sim/useSimulation.ts';

/** Time spans the user can choose from, seconds. */
const SPANS = [0.001, 0.01, 0.05, 0.2, 1, 2, 5];

export function ScopePanel({ sim }: { sim: SimulationController }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const running = useStudio((s) => s.snapshot.running);
  // Axes and graticule follow the theme; the trace colours do not. A channel that changed colour
  // would break the one thing a scope's colours are for.
  const mode = useTheme().palette.mode;
  const chrome = scopeChrome(mode);
  const COLORS = scopeTraceColors(mode);
  const simTime = useStudio((s) => s.snapshot.time);

  const [selected, setSelected] = useState<string[]>(['digital:D13']);
  const [span, setSpan] = useState(1);
  const [decode, setDecode] = useState(false);
  const [traces, setTraces] = useState<TraceData[]>([]);
  const [frames, setFrames] = useState<DecodedFrame[]>([]);
  const [available, setAvailable] = useState<{ id: string; label: string; kind: string }[]>([]);

  // Refresh the channel list when the circuit changes; new pins may have appeared.
  useEffect(() => {
    let cancelled = false;
    void sim.channels().then((specs) => {
      if (!cancelled) setAvailable(specs);
    });
    return () => {
      cancelled = true;
    };
  }, [sim, simTime === 0]);

  /** Pull a fresh window. Driven by a timer rather than every frame: 10 Hz is plenty to read. */
  const refresh = useCallback(async () => {
    const capture = await sim.captureSpan();
    const to = Math.max(capture.to, 0);
    const from = Math.max(capture.from, to - span);

    const data = await sim.traces(selected, from, to, 4000);
    setTraces(data);

    if (decode) {
      const serialChannel = selected.find((id) => id === 'digital:D1');
      setFrames(serialChannel ? await sim.decodeSerial(serialChannel, from, to) : []);
    } else {
      setFrames([]);
    }
  }, [sim, selected, span, decode]);

  useEffect(() => {
    void refresh();
    if (!running) return;
    const timer = setInterval(() => void refresh(), 100);
    return () => clearInterval(timer);
  }, [refresh, running]);

  /**
   * Series layout.
   *
   * Digital channels are offset onto their own lanes so they stack like a logic analyser; analog
   * channels share a volts axis. Mixing them on one scale would flatten a 0-1 logic trace against
   * a 0-5 V waveform into nothing.
   */
  const plotData = useMemo(() => {
    if (traces.length === 0) return null;

    // uPlot needs one shared x axis, so merge every trace's timestamps and step-sample onto it.
    const allTimes = new Set<number>();
    for (const trace of traces) for (const t of trace.times) allTimes.add(t);
    const times = [...allTimes].sort((a, b) => a - b);
    if (times.length === 0) return null;

    const digitalCount = traces.filter((t) => t.kind === 'digital').length;
    let lane = 0;

    const series = traces.map((trace, index) => {
      const values = new Array<number | null>(times.length);
      let cursor = 0;
      let last: number | null = null;

      for (let i = 0; i < times.length; i++) {
        while (cursor < trace.times.length && trace.times[cursor]! <= times[i]!) {
          last = trace.values[cursor]!;
          cursor += 1;
        }
        // Step interpolation: a digital line holds its level between transitions, it does not ramp.
        values[i] = last;
      }

      if (trace.kind === 'digital') {
        const offset = (digitalCount - 1 - lane) * 1.4;
        lane += 1;
        return {
          trace,
          color: COLORS[index % COLORS.length]!,
          values: values.map((v) => (v === null ? null : v * 0.8 + offset)),
        };
      }

      return { trace, color: COLORS[index % COLORS.length]!, values };
    });

    return { times, series };
    // COLORS is in here because it changes with the theme, and a memo that ignored it would keep
    // handing the plot the previous palette's traces forever.
  }, [traces, COLORS]);

  // Build the plot once, then feed it data. Recreating uPlot each frame would thrash the canvas.
  useEffect(() => {
    if (!containerRef.current || !plotData) return;

    const { times, series } = plotData;
    const data: uPlot.AlignedData = [
      times,
      ...series.map((s) => s.values as (number | null)[]),
    ];

    const options: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: Math.max(140, containerRef.current.clientHeight - 8),
      padding: [8, 12, 0, 0],
      cursor: { drag: { x: true, y: false } },
      legend: { show: false },
      axes: [
        {
          stroke: chrome.axis,
          grid: { stroke: chrome.grid },
          ticks: { stroke: chrome.grid },
          values: (_u, splits) => splits.map((v) => `${(v * 1000).toFixed(1)} ms`),
        },
        { stroke: chrome.axis, grid: { stroke: chrome.grid }, ticks: { stroke: chrome.grid } },
      ],
      series: [
        {},
        ...series.map((s) => ({
          label: s.trace.label,
          stroke: s.color,
          width: 1.6,
          // Digital lines step; analog lines interpolate.
          paths:
            s.trace.kind === 'digital'
              ? uPlot.paths.stepped!({ align: 1 })
              : uPlot.paths.linear!(),
          points: { show: false },
        })),
      ],
    };

    plotRef.current?.destroy();
    plotRef.current = new uPlot(options, data, containerRef.current);

    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // Rebuild when the *shape* changes; data-only updates go through setData below. The theme is
    // in here because uPlot bakes its axis colours into the options at construction, so a plot
    // built dark stays dark until something replaces it.
  }, [
    plotData?.series.length,
    plotData?.series.map((s) => s.trace.id).join(','),
    chrome.axis,
    chrome.grid,
  ]);

  useEffect(() => {
    if (!plotRef.current || !plotData) return;
    plotRef.current.setData([
      plotData.times,
      ...plotData.series.map((s) => s.values as (number | null)[]),
    ] as uPlot.AlignedData);
  }, [plotData]);

  // Keep the canvas sized to its panel.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      plotRef.current?.setSize({
        width: element.clientWidth,
        height: Math.max(140, element.clientHeight - 8),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const decoded = frames.length > 0
    ? frames
        .map((f) => (f.framingError ? '?' : printable(f.byte)))
        .join('')
    : null;

  return (
    <Stack sx={{ height: '100%' }}>
      <Stack direction="row" spacing={1} sx={{ p: 0.75, alignItems: 'center', flexWrap: 'wrap' }}>
        <Select
          multiple
          size="small"
          value={selected}
          onChange={(e) => setSelected(typeof e.target.value === 'string' ? [e.target.value] : e.target.value)}
          renderValue={(ids) => `${ids.length} channel${ids.length === 1 ? '' : 's'}`}
          sx={{ minWidth: 130 }}
        >
          {available.map((channel) => (
            <MenuItem key={channel.id} value={channel.id}>
              {channel.label} {channel.kind === 'analog' ? '(V)' : ''}
            </MenuItem>
          ))}
        </Select>

        <Select size="small" value={span} onChange={(e) => setSpan(Number(e.target.value))}>
          {SPANS.map((value) => (
            <MenuItem key={value} value={value}>
              {value < 1 ? `${value * 1000} ms` : `${value} s`}
            </MenuItem>
          ))}
        </Select>

        <FormControlLabel
          control={<Switch size="small" checked={decode} onChange={(e) => setDecode(e.target.checked)} />}
          label={<Typography variant="caption">Decode D1 as serial</Typography>}
        />

        {decoded !== null && (
          <Chip
            size="small"
            variant="outlined"
            label={`TX: ${decoded.slice(-40)}`}
            sx={{ fontFamily: 'ui-monospace, monospace' }}
          />
        )}
        {decode && frames.some((f) => f.framingError) && (
          <Chip size="small" color="error" label="framing error" />
        )}
      </Stack>

      <Divider />

      <Box ref={containerRef} sx={{ flex: 1, minHeight: 0, p: 0.5 }}>
        {traces.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            No captured signal yet. Run the sketch, then pick a channel above. Analog traces need
            to be enabled per pin — they store a sample per solve, so they are opt-in.
          </Typography>
        )}
      </Box>
    </Stack>
  );
}

function printable(byte: number): string {
  if (byte === 0x0a) return '⏎';
  if (byte === 0x0d) return '';
  if (byte >= 0x20 && byte < 0x7f) return String.fromCharCode(byte);
  return '·';
}
