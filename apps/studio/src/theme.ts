/**
 * Themes, light and dark.
 *
 * MUI supplies the components; this strips the Material look back to something closer to a bench
 * instrument -- flat surfaces, tight density, no drop shadows competing with the canvas. Both
 * palettes leave saturated colour to the circuit itself, so a lit LED or a red fault is the
 * brightest thing on screen either way.
 *
 * ## What does *not* change with the theme
 *
 * Most of the canvas. A breadboard is off-white plastic, an Arduino is teal, a resistor's bands
 * mean what they mean, and a red LED is red -- those are facts about the parts rather than
 * decisions about the interface, and repainting them for a light background would make the
 * simulator lie about what the bench looks like. What switches is the surface the parts sit on:
 * the workspace ground, the grid, the selection colour and the text drawn straight onto it.
 */
import { createTheme, type Theme } from '@mui/material/styles';

export type ThemeMode = 'light' | 'dark';
/** What the user asked for, which may be "whatever the system is doing". */
export type ThemePreference = ThemeMode | 'system';

const shared = {
  shape: { borderRadius: 4 },
  typography: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: 13,
    button: { textTransform: 'none' as const, fontWeight: 500 },
  },
  components: {
    MuiButton: { defaultProps: { size: 'small' as const, disableElevation: true } },
    MuiIconButton: { defaultProps: { size: 'small' as const } },
    MuiTextField: { defaultProps: { size: 'small' as const } },
    MuiSelect: { defaultProps: { size: 'small' as const } },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: { root: { backgroundImage: 'none' } },
    },
    MuiTooltip: { defaultProps: { arrow: true } },
  },
};

const DARK = createTheme({
  ...shared,
  palette: {
    mode: 'dark',
    background: { default: '#14161a', paper: '#1b1e24' },
    primary: { main: '#4da3ff' },
    secondary: { main: '#f5a524' },
    error: { main: '#ff5c5c' },
    warning: { main: '#f5a524' },
    success: { main: '#3ecf8e' },
    divider: '#2a2f38',
    text: { primary: '#e6e9ef', secondary: '#9aa4b2' },
  },
});

const LIGHT = createTheme({
  ...shared,
  palette: {
    mode: 'light',
    // Not white. A pure white ground next to the parts' own colours is glaring, and every
    // instrument bench this is modelled on is some shade of grey.
    background: { default: '#eef0f4', paper: '#ffffff' },
    primary: { main: '#1565c0' },
    secondary: { main: '#b26a00' },
    error: { main: '#c62828' },
    warning: { main: '#ed6c02' },
    success: { main: '#2e7d32' },
    divider: '#d9dee6',
    text: { primary: '#1a1d23', secondary: '#5a6371' },
  },
});

export const buildTheme = (mode: ThemeMode): Theme => (mode === 'dark' ? DARK : LIGHT);

// ---------------------------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------------------------

export interface CanvasPalette {
  background: string;
  grid: string;
  breadboardBody: string;
  breadboardChannel: string;
  breadboardHole: string;
  railPositive: string;
  railNegative: string;
  boardBody: string;
  boardHeader: string;
  pinBrass: string;
  wireDefault: string;
  selection: string;
  probeText: string;
}

const CANVAS_PALETTES: Record<ThemeMode, CanvasPalette> = {
  dark: {
    background: '#0f1115',
    grid: '#1c2027',
    breadboardBody: '#e8e6e0',
    breadboardChannel: '#d2cfc7',
    breadboardHole: '#8d8a83',
    railPositive: '#d84a4a',
    railNegative: '#3f6fd8',
    boardBody: '#0f7b8a',
    boardHeader: '#15181d',
    pinBrass: '#d9b25a',
    wireDefault: '#c0392b',
    selection: '#4da3ff',
    probeText: '#9aa4b2',
  },
  light: {
    background: '#e7eaef',
    grid: '#cfd5de',
    // The physical colours are the same in both. See the note at the top.
    breadboardBody: '#e8e6e0',
    breadboardChannel: '#d2cfc7',
    breadboardHole: '#8d8a83',
    railPositive: '#d84a4a',
    railNegative: '#3f6fd8',
    boardBody: '#0f7b8a',
    boardHeader: '#15181d',
    pinBrass: '#b08a2e',
    wireDefault: '#c0392b',
    selection: '#1565c0',
    probeText: '#4a5261',
  },
};

/**
 * The colours the canvas is currently drawing with.
 *
 * A mutable object rather than a value passed down, because the canvas is a Konva tree: React
 * context does not cross the `Stage` boundary without a bridge, and threading a palette through
 * every shape would be a lot of plumbing for a handful of colours. Replaced wholesale by
 * `applyCanvasPalette` before the tree renders, so every shape reads the same set within a frame.
 */
export const canvas: CanvasPalette = { ...CANVAS_PALETTES.dark };

export function applyCanvasPalette(mode: ThemeMode): void {
  Object.assign(canvas, CANVAS_PALETTES[mode]);
}

// ---------------------------------------------------------------------------------------------
// Instruments that bring their own themes
// ---------------------------------------------------------------------------------------------

/** Monaco's built-in themes, which are the ones its C++ grammar was tuned against. */
export const editorTheme = (mode: ThemeMode): string => (mode === 'dark' ? 'vs-dark' : 'vs');

/** xterm has no default that suits either, so both are stated. */
export const terminalTheme = (mode: ThemeMode) =>
  mode === 'dark'
    ? { background: '#14161a', foreground: '#e6e9ef', cursor: '#4da3ff' }
    : { background: '#ffffff', foreground: '#1a1d23', cursor: '#1565c0' };

/**
 * Scope chrome: the axes and graticule, not the traces.
 *
 * Trace colours stay put. A channel that changed colour with the theme would break the one thing
 * a scope's colours are for, which is telling you which probe you are looking at.
 */
export const scopeChrome = (mode: ThemeMode) =>
  mode === 'dark'
    ? { axis: '#9aa4b2', grid: '#242a33' }
    : { axis: '#5a6371', grid: '#dde1e7' };

/**
 * Trace colours, in the same order in both palettes.
 *
 * Same hues, darkened for a light ground. The order is what carries the meaning -- channel one is
 * blue, channel two is green -- so it is the lightness that changes and never the sequence. A pale
 * yellow trace is perfectly readable on black and invisible on white, which is the whole reason
 * this is not one list.
 */
const SCOPE_TRACES: Record<ThemeMode, readonly string[]> = {
  dark: ['#4da3ff', '#3ecf8e', '#f5a524', '#ff5c5c', '#b388ff', '#4dd0e1', '#ffd54f', '#f06292'],
  light: ['#1565c0', '#1b7f4f', '#b26a00', '#c62828', '#6a3fbf', '#0e7490', '#8a6d00', '#ad1457'],
};

export const scopeTraceColors = (mode: ThemeMode): readonly string[] => SCOPE_TRACES[mode];
