/**
 * The Help menu, made to actually help.
 *
 * Its three entries used to be text pinned inside a dropdown -- a paragraph you could read and not
 * click, and a list of shortcuts squeezed onto one line. Each is now a dialog with the room to say
 * the whole thing, which is what someone opening Help was looking for.
 *
 * Written for the person who has just arrived. "Getting started" is first because that is the
 * question Help is usually asked.
 */
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import { isMac } from '../shortcuts.ts';

export type HelpTopic = 'start' | 'shortcuts' | 'about';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const TITLES: Record<HelpTopic, string> = {
  start: 'Getting started',
  shortcuts: 'Keyboard shortcuts',
  about: 'About robo-journey',
};

/** One step of the walkthrough. Numbered, because the order is the point. */
function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <Stack direction="row" spacing={2}>
      <Box
        sx={{
          flexShrink: 0,
          width: 26,
          height: 26,
          borderRadius: '50%',
          border: 1,
          borderColor: 'primary.main',
          color: 'primary.main',
          display: 'grid',
          placeItems: 'center',
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        {n}
      </Box>
      <Box>
        <Typography sx={{ fontWeight: 600 }}>{title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, lineHeight: 1.7 }}>
          {body}
        </Typography>
      </Box>
    </Stack>
  );
}

/**
 * Every binding, grouped the way they are reached for.
 *
 * The single-key ones are last and marked, because they only work when you are not typing -- which
 * is the one thing about them that surprises people.
 */
function Shortcuts() {
  const mod = isMac ? '⌘' : 'Ctrl';
  const groups: { heading: string; rows: [string, string][] }[] = [
    {
      heading: 'Running',
      rows: [
        [`${mod} ↵`, 'Build and run'],
        [`${mod} B`, 'Compile only'],
      ],
    },
    {
      heading: 'Project',
      rows: [
        [`${mod} S`, 'Save to a file'],
        [`${mod} ⇧ S`, 'Save to your account'],
        [`${mod} O`, 'Open a project'],
        [`${mod} Z`, 'Undo'],
        [`${mod} ⇧ Z`, 'Redo'],
      ],
    },
    {
      heading: 'Selecting',
      rows: [
        ['Drag empty canvas', 'Sweep up everything the band touches'],
        ['⇧ Click', 'Add a part, or take one out'],
        ['⇧ Drag', 'Add what the band touches to the selection'],
        [`${mod} A`, 'Select everything'],
        ['Esc', 'Back out: the wire, then the tool, then the selection'],
      ],
    },
    {
      heading: 'On the canvas',
      rows: [
        ['Space + drag', 'Pan'],
        ['Arrows', 'Move the selection a hole — or pan, with nothing selected'],
        ['⇧ Arrows', 'Ten holes at a time'],
        ['R', 'Turn the selection 90°'],
        ['⇧ R', 'Turn it the other way'],
        [`${mod} D`, 'Duplicate the selection'],
        [`${mod} C / ${mod} V`, 'Copy and paste parts'],
        ['1', 'Fit the circuit to the view'],
        ['Delete', 'Remove the selection'],
      ],
    },
  ];

  return (
    <Stack spacing={3}>
      {groups.map((group) => (
        <Box key={group.heading}>
          <Typography variant="overline" color="text.secondary">
            {group.heading}
          </Typography>
          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
            {group.rows.map(([keys, what]) => (
              <Stack key={keys} direction="row" sx={{ alignItems: 'center', gap: 2 }}>
                <Box
                  sx={{
                    minWidth: 84,
                    px: 1,
                    py: 0.25,
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 0.75,
                    fontFamily: MONO,
                    fontSize: 12,
                    textAlign: 'center',
                  }}
                >
                  {keys}
                </Box>
                <Typography variant="body2">{what}</Typography>
              </Stack>
            ))}
          </Stack>
        </Box>
      ))}
      <Divider />
      <Typography variant="body2" color="text.secondary">
        The single-key ones — R, 1 and Delete — do nothing while you are typing in the editor or a
        text box, so they never eat a character you meant to type.
      </Typography>
    </Stack>
  );
}

export function HelpDialog({ topic, onClose }: { topic: HelpTopic | null; onClose(): void }) {
  return (
    <Dialog open={topic !== null} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{topic ? TITLES[topic] : ''}</DialogTitle>
      <DialogContent dividers>
        {topic === 'start' && (
          <Stack spacing={3}>
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.75 }}>
              This is a workbench. You put parts on it, wire them together, write the code, and
              press Run — and it behaves like the real thing, including the mistakes.
            </Typography>
            <Step
              n={1}
              title="Open something that already works"
              body="Library, in the menu bar, has ready-made projects grouped by what they show. Open one, press Build & Run, and watch it go. Changing a working circuit is a much easier way in than starting from an empty board."
            />
            <Step
              n={2}
              title="Place parts and wire them"
              body="Pick a part from the list on the left and click the canvas to put it down. Drag from one pin to another to run a wire. Right-click a part to turn it, unplug it or delete it."
            />
            <Step
              n={3}
              title="Set the scene"
              body="Sensors need something to sense. The Interaction toolkit has a flame, a magnet, a lamp, someone walking past — drop one near a sensor and drag it closer to see the reading change."
            />
            <Step
              n={4}
              title="Watch what it tells you"
              body="Problems, along the bottom, is where it says what would go wrong on a real board — too much current through a pin, a floating input, a supply that cannot hold its voltage. An empty Problems panel is the circuit passing."
            />
            <Step
              n={5}
              title="Measure things"
              body="The multimeter, ammeter and oscilloscope are parts like any other. Drop one on the canvas and run its probes to any point in the circuit."
            />
          </Stack>
        )}

        {topic === 'shortcuts' && <Shortcuts />}

        {topic === 'about' && (
          <Stack spacing={2.5}>
            <Typography variant="body2" sx={{ lineHeight: 1.8 }}>
              robo-journey builds and tests Arduino circuits in your browser. Your sketch is
              compiled and then run exactly as the chip would run it, and the circuit around it is
              worked out properly — every volt, every milliamp, part by part.
            </Typography>
            <Typography variant="body2" sx={{ lineHeight: 1.8 }}>
              That combination is the whole point. A simulator that only runs the code will light an
              LED whether or not your circuit could actually light one. This one can tell you that
              you forgot the resistor, that nothing is connected to the pin you are reading, or that
              your supply cannot deliver what you are asking of it.
            </Typography>
            <Divider />
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                What it does not do
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.8 }}>
                Plenty, and every part says so in its own properties. Some displays accept what you
                send them and draw nothing; a relay's contacts do not switch; parts on their own
                one-wire protocols are not here yet. A tool that hides its limits is not one you can
                trust with anything, so it does not hide them.
              </Typography>
            </Box>
            <Divider />
            <Typography variant="body2" color="text.secondary">
              Board: Arduino Uno, ATmega328P at 16 MHz. Free to use, nothing to install.
            </Typography>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
