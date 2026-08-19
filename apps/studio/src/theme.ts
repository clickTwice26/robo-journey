/**
 * Dark engineering theme.
 *
 * MUI supplies the components; this strips the Material look back to something closer to a bench
 * instrument -- flat surfaces, tight density, no drop shadows competing with the canvas. The
 * palette leaves saturated colour to the circuit itself, so a lit LED or a red fault is the
 * brightest thing on screen.
 */
import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
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
  shape: { borderRadius: 4 },
  typography: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: 13,
    button: { textTransform: 'none', fontWeight: 500 },
  },
  components: {
    MuiButton: { defaultProps: { size: 'small', disableElevation: true } },
    MuiIconButton: { defaultProps: { size: 'small' } },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiSelect: { defaultProps: { size: 'small' } },
    MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiTooltip: { defaultProps: { arrow: true } },
  },
});

/** Colours the canvas uses. Kept beside the theme so the two never drift apart. */
export const canvas = {
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
} as const;
