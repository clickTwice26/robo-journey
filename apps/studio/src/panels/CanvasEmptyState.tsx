/**
 * What an empty workspace says for itself.
 *
 * A blank grid is an honest picture of an empty project and a terrible first screen: it tells
 * somebody who has just arrived nothing about what this is, what it can do, or what to press. The
 * first thirty seconds decide whether there is a thirty-first.
 *
 * So the empty canvas offers the three real ways in -- open something that already works, place a
 * board, or ask -- and, underneath, the one sentence that says what makes this different from the
 * other simulators. It disappears the moment there is a single part, and never comes back.
 */
import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import DeveloperBoardIcon from '@mui/icons-material/DeveloperBoard';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import BoltIcon from '@mui/icons-material/Bolt';
import { useStudio } from '../store.ts';

export function CanvasEmptyState({
  onOpenLibrary,
  onAskAi,
}: {
  onOpenLibrary: () => void;
  onAskAi: () => void;
}) {
  const setMode = useStudio((s) => s.setMode);

  const ways = [
    {
      icon: <MenuBookIcon />,
      title: 'Open an example',
      detail: 'A circuit that already works, wired and ready to run.',
      action: onOpenLibrary,
      primary: true,
    },
    {
      icon: <DeveloperBoardIcon />,
      title: 'Start with a board',
      detail: 'Place an Arduino Uno, then wire parts onto it.',
      action: () => setMode({ kind: 'place', partType: 'arduino-uno' }),
    },
    {
      icon: <AutoAwesomeIcon />,
      title: 'Describe what you want',
      detail: 'Ask the assistant to build it and watch it wire itself.',
      action: onAskAi,
    },
  ];

  return (
    // Pointer-transparent as a whole, so the canvas underneath still pans and takes a part drop;
    // the cards themselves take their clicks back.
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        pointerEvents: 'none',
        p: 3,
      }}
    >
      <Stack spacing={2.5} sx={{ maxWidth: 620, width: '100%', alignItems: 'center' }}>
        <Stack spacing={0.75} sx={{ alignItems: 'center', textAlign: 'center' }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Build a circuit
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 460 }}>
            Drag parts onto a breadboard, wire them up, write your sketch and press Run. Your code
            runs on a real emulated ATmega328P, and a real solver works out the voltage at every
            node.
          </Typography>
        </Stack>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ width: '100%' }}>
          {ways.map((way) => (
            <Paper
              key={way.title}
              variant="outlined"
              sx={{
                flex: 1,
                p: 1.75,
                borderRadius: 2,
                pointerEvents: 'auto',
                cursor: 'pointer',
                transition: 'border-color 120ms, transform 120ms',
                '&:hover': { borderColor: 'primary.main', transform: 'translateY(-2px)' },
                ...(way.primary ? { borderColor: 'primary.main' } : {}),
              }}
              onClick={way.action}
            >
              <Stack spacing={0.75}>
                <Box sx={{ color: way.primary ? 'primary.main' : 'text.secondary' }}>
                  {way.icon}
                </Box>
                <Typography variant="subtitle2">{way.title}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.5 }}>
                  {way.detail}
                </Typography>
              </Stack>
            </Paper>
          ))}
        </Stack>

        {/* The one claim worth making on an empty screen, because it is the one thing the other
            simulators do not do. */}
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', opacity: 0.75, pointerEvents: 'auto' }}
        >
          <BoltIcon sx={{ fontSize: 16, color: 'warning.main' }} />
          <Typography variant="caption" color="text.secondary">
            Wire an LED without a resistor and it will tell you — 78 mA against a 40 mA maximum.
            Other simulators light it up.
          </Typography>
        </Stack>

        <Button
          size="small"
          sx={{ pointerEvents: 'auto', color: 'text.disabled' }}
          onClick={onOpenLibrary}
        >
          or press ⌘K to search everything
        </Button>
      </Stack>
    </Box>
  );
}
