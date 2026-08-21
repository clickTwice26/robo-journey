/**
 * The landing page.
 *
 * Written for somebody who has not built the thing yet. The plain sentence goes first and the
 * evidence goes underneath it, so the page can be read by a beginner and checked by an engineer
 * without being two different pages.
 *
 * Everything on it is a claim the product can be held to. The comparison table is the actual state
 * of the tools it sits beside, the fault messages are the strings the fault detector really emits,
 * and the counts come from the library rather than from a copywriter.
 *
 * Visually it is the workspace: same palette, same restraint, same instrument feel, and it follows
 * the light and dark themes for the same reason the app does. Somebody arriving here and then
 * pressing Try now should not feel they have gone somewhere else.
 */
import { Box, Button, Container, Divider, Stack, Typography } from '@mui/material';
import { LandingDemo } from './LandingDemo.tsx';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import BoltIcon from '@mui/icons-material/Bolt';
import MemoryIcon from '@mui/icons-material/Memory';
import RuleIcon from '@mui/icons-material/Rule';
import {
  BUILTIN_MANIFESTS,
  INSTRUMENTS,
  LIBRARY_PROJECTS,
  STIMULI,
  builtinParts,
} from '@robo-journey/parts';

/**
 * Counted rather than typed, so the page cannot drift from the library it is describing.
 *
 * Components means components: the boards, the instruments and the things you put on the workspace
 * to trigger a sensor are all counted separately, because rolling them into one number to make it
 * bigger is the sort of thing the people who use this would check.
 */
const COUNTS = {
  components:
    BUILTIN_MANIFESTS.length +
    builtinParts().filter((p) => !['board', 'instrument', 'stimulus'].includes(p.category)).length,
  projects: LIBRARY_PROJECTS.length,
  instruments: INSTRUMENTS.length,
  stimuli: STIMULI.length,
};

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** The section the hero's second button jumps to. */
const CATCHES_ID = 'what-it-catches';

function Section({
  children,
  bordered = true,
}: {
  children: React.ReactNode;
  bordered?: boolean;
}) {
  return (
    <Box
      component="section"
      sx={{
        py: { xs: 8, md: 14 },
        ...(bordered ? { borderTop: 1, borderColor: 'divider' } : {}),
      }}
    >
      <Container maxWidth="lg">{children}</Container>
    </Box>
  );
}

function SectionHeading({ title, lead }: { title: string; lead?: string }) {
  return (
    <Box sx={{ maxWidth: 720, mb: { xs: 4, md: 7 } }}>
      <Typography
        variant="h3"
        sx={{ fontWeight: 600, letterSpacing: '-0.02em', fontSize: { xs: '1.9rem', md: '2.5rem' } }}
      >
        {title}
      </Typography>
      {lead && (
        <Typography sx={{ mt: 2, color: 'text.secondary', fontSize: '1.05rem', lineHeight: 1.65 }}>
          {lead}
        </Typography>
      )}
    </Box>
  );
}

/** Where this sits among the tools people already use. Every cell is checkable. */
function Comparison() {
  const rows: { tool: string; firmware: string; analog: string; cost: string; ours?: boolean }[] = [
    { tool: 'Wokwi', firmware: 'Yes — cycle-accurate AVR', analog: 'None', cost: 'Free' },
    { tool: 'Tinkercad Circuits', firmware: 'Approximated', analog: 'Partial', cost: 'Free' },
    { tool: 'Proteus VSM', firmware: 'Yes', analog: 'Yes', cost: 'Commercial' },
    { tool: 'robo-journey', firmware: 'Yes — cycle-accurate AVR', analog: 'Yes — nodal solver', cost: 'Free', ours: true },
  ];

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, overflowX: 'auto' }}>
      <Box component="table" sx={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
        <Box component="thead">
          <Box component="tr">
            {['', 'Runs real firmware', 'Simulates the analog circuit', ''].map((head, i) => (
              <Box
                component="th"
                key={head || i}
                sx={{
                  textAlign: 'left',
                  px: 2.5,
                  py: 1.75,
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'text.secondary',
                  borderBottom: 1,
                  borderColor: 'divider',
                }}
              >
                {head}
              </Box>
            ))}
          </Box>
        </Box>
        <Box component="tbody">
          {rows.map((row) => (
            <Box
              component="tr"
              key={row.tool}
              sx={{ bgcolor: row.ours ? 'action.hover' : 'transparent' }}
            >
              <Box
                component="td"
                sx={{
                  px: 2.5,
                  py: 2,
                  fontWeight: row.ours ? 700 : 500,
                  color: row.ours ? 'primary.main' : 'text.primary',
                  borderBottom: 1,
                  borderColor: 'divider',
                  whiteSpace: 'nowrap',
                }}
              >
                {row.tool}
              </Box>
              {[row.firmware, row.analog, row.cost].map((cell, i) => (
                <Box
                  component="td"
                  key={i}
                  sx={{
                    px: 2.5,
                    py: 2,
                    color:
                      cell === 'None' || cell === 'Approximated' || cell === 'Commercial'
                        ? 'text.secondary'
                        : 'text.primary',
                    borderBottom: 1,
                    borderColor: 'divider',
                    fontSize: '0.95rem',
                  }}
                >
                  {cell}
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

/**
 * What went wrong, said twice.
 *
 * The plain sentence is what somebody needs to know; the line underneath is what the simulator
 * actually printed, which is what makes the plain sentence believable.
 */
function Fault({ title, message }: { title: string; message: string }) {
  return (
    <Box
      sx={{
        flex: 1,
        p: 3,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5,
      }}
    >
      <Typography sx={{ fontWeight: 600, fontSize: '1.05rem' }}>{title}</Typography>
      <Typography
        sx={{
          mt: 1.5,
          pt: 1.5,
          borderTop: 1,
          borderColor: 'divider',
          fontFamily: MONO,
          fontSize: 12.5,
          lineHeight: 1.7,
          color: 'text.secondary',
        }}
      >
        {message}
      </Typography>
    </Box>
  );
}

function Pillar({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Box sx={{ flex: 1, minWidth: 260 }}>
      <Box sx={{ color: 'primary.main', mb: 1.5, display: 'flex' }}>{icon}</Box>
      <Typography sx={{ fontWeight: 600, fontSize: '1.05rem', mb: 1 }}>{title}</Typography>
      <Typography sx={{ color: 'text.secondary', lineHeight: 1.7 }}>{body}</Typography>
    </Box>
  );
}

export function Landing({ onEnter }: { onEnter(): void }) {

  const showCatches = () => {
    const target = document.getElementById(CATCHES_ID);
    if (!target) return;

    // Walk up from the target to whatever is actually scrolling, rather than assuming which
    // element that is. The page scrolls inside a container instead of the window, and a ref held
    // on the wrong box measures a correct distance against the wrong origin -- which is a bug that
    // looks exactly like the button doing nothing.
    let box: HTMLElement | null = target.parentElement;
    while (box && box.scrollHeight <= box.clientHeight + 4) box = box.parentElement;
    if (!box) return;

    // Sixty pixels of headroom keeps the sticky header off the heading.
    const top =
      target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 60;

    // Asked for smoothly, taken instantly if that is not on offer. `behavior: 'smooth'` silently
    // does nothing on a scrolling container in some browsers rather than falling back, and a
    // button that appears not to work is a worse outcome than one that jumps.
    box.scrollTo({ top, behavior: 'smooth' });
    if (Math.abs(box.scrollTop - top) > 4) box.scrollTop = top;
  };

  // The same words for everyone. Telling a signed-in visitor something different would mean asking
  // the account service who they are before the page can render, and a public page should cost a
  // visitor nothing -- not a request, and not a seat.
  const cta = 'Try now';

  return (
    // Fills the root and scrolls inside it rather than growing past it: the workspace needs
    // `html, body, #root` locked to the viewport, so a page that is taller than the screen has to
    // do its own scrolling or the bottom of it is simply unreachable.
    <Box sx={{ height: '100%', bgcolor: 'background.default', overflowY: 'auto' }}>
      {/* Nav */}
      <Box
        component="header"
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: 'background.default',
          backdropFilter: 'blur(8px)',
        }}
      >
        <Container maxWidth="lg">
          <Stack direction="row" sx={{ alignItems: 'center', height: 60, gap: 3 }}>
            <Typography sx={{ fontWeight: 700, letterSpacing: '-0.01em' }}>robo-journey</Typography>
            <Box sx={{ flex: 1 }} />
            <Button size="small" variant="contained" onClick={onEnter} endIcon={<ArrowForwardIcon />}>
              {cta}
            </Button>
          </Stack>
        </Container>
      </Box>

      {/* Hero */}
      <Box
        sx={{
          py: { xs: 8, md: 14 },
          // The workspace's own grid, faint. It says what kind of tool this is before a word is read.
          backgroundImage: (theme) =>
            `radial-gradient(${theme.palette.divider} 1px, transparent 1px)`,
          backgroundSize: '28px 28px',
        }}
      >
        <Container maxWidth="lg">
          <Stack direction={{ xs: 'column', md: 'row' }} sx={{ gap: { xs: 6, md: 8 }, alignItems: 'center' }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="h1"
                sx={{
                  fontWeight: 600,
                  letterSpacing: '-0.03em',
                  lineHeight: 1.08,
                  fontSize: { xs: '2.4rem', sm: '2.9rem', md: '3.5rem' },
                  maxWidth: 560,
                }}
              >
                Try your Arduino project before you build it.
              </Typography>

              <Typography
                sx={{
                  mt: 3,
                  color: 'text.secondary',
                  fontSize: '1.12rem',
                  lineHeight: 1.7,
                  maxWidth: 560,
                }}
              >
                Drag parts onto a breadboard, wire them up, write your code and press Run. It
                behaves like the real thing — including the mistakes. Wire something wrong and it
                says so, instead of quietly working anyway.
              </Typography>

              <Stack direction="row" sx={{ gap: 1.5, mt: 4, flexWrap: 'wrap' }}>
                <Button
                  size="large"
                  variant="contained"
                  onClick={onEnter}
                  endIcon={<ArrowForwardIcon />}
                  sx={{ px: 3, py: 1.25 }}
                >
                  {cta}
                </Button>
                <Button
                  size="large"
                  variant="outlined"
                  // Scrolled rather than linked, so the address bar does not pick up a fragment.
                  onClick={showCatches}
                  sx={{ px: 3, py: 1.25 }}
                >
                  See what it catches
                </Button>
              </Stack>

 
            </Box>

            <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
              <LandingDemo />
            </Box>
          </Stack>
        </Container>
      </Box>

      {/* The gap */}
      <Section>
        <SectionHeading
          title="Other simulators run your code. This one runs the electricity too."
          lead="Most of them will happily light an LED whether or not your circuit could actually light one. That is the difference between a simulator that agrees with you and one that can warn you."
        />
        <Comparison />
      </Section>

      {/* What it catches */}
      <Box id={CATCHES_ID}>
        <Section>
          <SectionHeading
            title="It tells you what would go wrong."
            lead="Three things it spotted that a real board would only show you after you had built it — and soldered it, and wondered why it did not work."
          />
          <Stack direction={{ xs: 'column', md: 'row' }} sx={{ gap: 2.5 }}>
            <Fault
              title="You left out the resistor"
              message="D13 → LED with no series resistor: 78 mA exceeds the 40 mA absolute maximum."
            />
            <Fault
              title="Nothing is connected to that pin"
              message="A0 is floating at 1.9 V, between VIL (1.50 V) and VIH (3.00 V). What it reads is undefined."
            />
            <Fault
              title="There is not enough voltage to go round"
              message="7805 needs 7.00 V in to hold 5 V out. It has 5.00 V, and its output has collapsed."
            />
          </Stack>
        </Section>
      </Box>

      {/* What is in it */}
      <Section>
        <SectionHeading
          title="Everything you would have on the desk."
          lead="Real parts with the numbers off their datasheets, instruments to measure them with, and things to wave in front of a sensor to set it off."
        />
        <Stack direction="row" sx={{ gap: { xs: 3, md: 6 }, flexWrap: 'wrap' }}>
          {[
            { n: COUNTS.components, label: 'parts', note: 'sensors, motors, screens, chips' },
            { n: COUNTS.projects, label: 'ready-made projects', note: 'open one and press Run' },
            { n: COUNTS.instruments, label: 'instruments', note: 'multimeter, ammeter, oscilloscope' },
            { n: COUNTS.stimuli, label: 'things to set sensors off', note: 'a flame, a magnet, movement' },
          ].map((stat) => (
            <Box key={stat.label} sx={{ minWidth: 190 }}>
              <Typography
                sx={{
                  fontSize: { xs: '2.6rem', md: '3.2rem' },
                  fontWeight: 600,
                  letterSpacing: '-0.03em',
                  lineHeight: 1,
                }}
              >
                {stat.n}
              </Typography>
              <Typography sx={{ mt: 1, fontWeight: 600 }}>{stat.label}</Typography>
              <Typography sx={{ color: 'text.secondary', fontSize: 14 }}>{stat.note}</Typography>
            </Box>
          ))}
        </Stack>
      </Section>

      {/* Pillars */}
      <Section>
        <Stack direction={{ xs: 'column', md: 'row' }} sx={{ gap: { xs: 5, md: 7 } }}>
          <Pillar
            icon={<MemoryIcon />}
            title="Your code really runs"
            body="Write a sketch the way you normally would. It gets compiled and then run exactly as the chip would run it, right down to the timing — so if something only breaks after four seconds, it breaks here after four seconds too."
          />
          <Pillar
            icon={<BoltIcon />}
            title="So does the electricity"
            body="Every volt and every milliamp is worked out properly, part by part. An LED is as bright as the current going through it, not as bright as your code hoped — and a battery sags under load the way a real one does."
          />
          <Pillar
            icon={<RuleIcon />}
            title="And it admits what it cannot do"
            body="Every part says plainly what it does not simulate — the relay whose contacts do not switch, the screen that takes your pixels and draws none. A tool that hides its limits is not one you can trust with anything."
          />
        </Stack>
      </Section>

      {/* Closing */}
      <Section>
        <Box sx={{ textAlign: 'center', maxWidth: 640, mx: 'auto' }}>
          <Typography
            variant="h3"
            sx={{ fontWeight: 600, letterSpacing: '-0.02em', fontSize: { xs: '1.9rem', md: '2.5rem' } }}
          >
            Have a go.
          </Typography>
          <Typography sx={{ mt: 2, color: 'text.secondary', fontSize: '1.05rem', lineHeight: 1.7 }}>
            Open one of the ready-made projects, or start with an empty board and wire it yourself.
          </Typography>
          <Button
            size="large"
            variant="contained"
            onClick={onEnter}
            endIcon={<ArrowForwardIcon />}
            sx={{ mt: 4, px: 4, py: 1.4 }}
          >
            {cta}
          </Button>
        </Box>
      </Section>

      <Divider />
      <Container maxWidth="lg">
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          sx={{ alignItems: 'center', gap: 1.5, py: 4, color: 'text.secondary' }}
        >
          <Typography sx={{ fontWeight: 600, color: 'text.primary' }}>robo-journey</Typography>
          <Typography sx={{ fontSize: 13 }}>
            Build and test Arduino circuits in your browser.
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Typography sx={{ fontSize: 13 }}>Free · Nothing to install</Typography>
        </Stack>
      </Container>
    </Box>
  );
}
