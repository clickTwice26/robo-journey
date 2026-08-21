/**
 * What is coming.
 *
 * Everything on this list is unbuilt, and the list says so at the top rather than in small print at
 * the bottom. A roadmap that reads like a feature list is a roadmap that generates support mail
 * from people trying to find a menu item that does not exist -- so each entry carries where it
 * actually is, and "In design" means in design.
 *
 * There is no price and no checkout here, because there is nothing to sell yet. A payment flow in
 * front of features that do not exist would be a worse thing to build than any of them.
 */
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import BluetoothIcon from '@mui/icons-material/Bluetooth';
import WifiIcon from '@mui/icons-material/Wifi';
import MemoryIcon from '@mui/icons-material/Memory';
import DeveloperBoardIcon from '@mui/icons-material/DeveloperBoard';
import type { ReactNode } from 'react';

type Stage = 'In design' | 'Planned' | 'Being scoped';

interface Upcoming {
  readonly icon: ReactNode;
  readonly title: string;
  readonly stage: Stage;
  readonly body: string;
}

/**
 * In the order they are likely to arrive, which is not the order of how much people ask for them.
 *
 * ESP32 is first because the other two need it: there is no Wi-Fi to simulate until there is a
 * chip with a radio on it.
 */
const UPCOMING: readonly Upcoming[] = [
  {
    icon: <MemoryIcon />,
    title: 'ESP32',
    stage: 'In design',
    body:
      'A second chip, and the one the other two need — there is nothing to put a radio on until it ' +
      'exists. The same treatment the ATmega328P gets: real firmware, cycle by cycle, against a ' +
      'real circuit. That is the hard part, and the reason this is not a checkbox.',
  },
  {
    icon: <WifiIcon />,
    title: 'Wi-Fi',
    stage: 'Planned',
    body:
      'HTTP from a sketch, against a network you can break on purpose: a slow DNS answer, a ' +
      'captive portal, a router that drops the connection halfway through a POST. The failures are ' +
      'the point — anyone can simulate a request that works.',
  },
  {
    icon: <BluetoothIcon />,
    title: 'Bluetooth LE',
    stage: 'Planned',
    body:
      'Advertise as a peripheral, expose characteristics, and connect from a simulated central. ' +
      'Including pairing that fails the way real pairing fails, which is most of what makes BLE ' +
      'hard to get right on a bench.',
  },
  {
    icon: <DeveloperBoardIcon />,
    title: 'More boards',
    stage: 'Being scoped',
    body:
      'Nano and Mega. Same core underneath, different pinout and different memory — so a sketch ' +
      'that runs out of RAM on one and not the other does exactly that here.',
  },
];

const STAGE_COLOR: Record<Stage, 'primary' | 'default' | 'secondary'> = {
  'In design': 'primary',
  Planned: 'default',
  'Being scoped': 'secondary',
};

export function UpgradeDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>What is coming</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.75 }}>
          None of this is built yet. It is what is being worked on next, in roughly this order —
          listed here so you can see where the thing is going before deciding to build on it.
        </Typography>

        <Stack spacing={2.5} sx={{ mt: 3 }}>
          {UPCOMING.map((item) => (
            <Stack key={item.title} direction="row" spacing={2}>
              <Box sx={{ color: 'primary.main', pt: 0.25, flexShrink: 0, display: 'flex' }}>
                {item.icon}
              </Box>
              <Box>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.25 }}>
                  <Typography sx={{ fontWeight: 600 }}>{item.title}</Typography>
                  <Chip
                    size="small"
                    variant="outlined"
                    color={STAGE_COLOR[item.stage]}
                    label={item.stage}
                    sx={{ height: 18, fontSize: 10 }}
                  />
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
                  {item.body}
                </Typography>
              </Box>
            </Stack>
          ))}
        </Stack>

        <Divider sx={{ my: 3 }} />

        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.75 }}>
          Everything in the app today is free and stays that way. Credits for the assistant come
          with a confirmed account, and more arrive when someone joins on your invite.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
