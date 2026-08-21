/**
 * What a part is, on hover.
 *
 * The palette is a column of names, and a name is not enough to choose by: "SW-420" tells you
 * nothing until you have already placed one and read the Properties panel. The canvas has the
 * opposite problem -- the artwork is a footprint drawn to scale, which is the right thing for
 * wiring and the wrong thing for recognising a component.
 *
 * So this is the answer to "what is that": the photograph, the one-line description off the
 * datasheet, what the world does to it, what it does back, and the numbers that decide whether it
 * survives being wired up wrong. Everything comes from the definition, so a part generated from a
 * datasheet this morning gets the same card as one that ships with the app.
 */
import { Box, Chip, Divider, Stack, Typography } from '@mui/material';
import BoltIcon from '@mui/icons-material/Bolt';
import type { PartDefinition } from '@robo-journey/parts';
import { PartPortrait } from './PartPortrait.tsx';

/** Plain words for the quantities, matching the Properties panel rather than the engine. */
const QUANTITY_LABELS: Record<string, string> = {
  light: 'light',
  sound: 'sound',
  temperature: 'heat',
  flame: 'infrared',
  motion: 'movement',
  magnet: 'magnetism',
  distance: 'anything solid in front of it',
  gas: 'smoke',
  moisture: 'water',
  vibration: 'being shaken',
};

const CATEGORY_LABELS: Record<string, string> = {
  board: 'Board',
  passive: 'Passive',
  output: 'Output',
  input: 'Input',
  power: 'Power',
  instrument: 'Instrument',
  stimulus: 'Interaction toolkit',
};

/** A row of `label — value`, skipped entirely when there is no value to show. */
function Fact({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between' }}>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ textAlign: 'right' }}>
        {value}
      </Typography>
    </Stack>
  );
}

/** Currents are held in amps and read in milliamps, which is how a datasheet prints them. */
function milliamps(amps: number | undefined): string | undefined {
  if (amps === undefined) return undefined;
  return amps >= 1 ? `${amps.toFixed(amps % 1 ? 1 : 0)} A` : `${Math.round(amps * 1000)} mA`;
}

/** The supply range as one line, however much of it the datasheet gave. */
function supplyRange(min: number | undefined, max: number | undefined): string | undefined {
  if (min !== undefined && max !== undefined) return `${min} – ${max} V`;
  if (max !== undefined) return `up to ${max} V`;
  if (min !== undefined) return `from ${min} V`;
  return undefined;
}

export function PartCard({
  definition,
  props = {},
  /** The instance's id, when the card is describing a part that is actually on the workspace. */
  instanceId,
}: {
  definition: PartDefinition;
  props?: Record<string, unknown>;
  instanceId?: string;
}) {
  const spec = definition.spec;
  const limits = spec?.limits;
  const senses = (definition.state ?? []).filter((v) => v.quantity);
  // Pins are the other half of "can I use this": how many, and what they are called on the module.
  const pins = definition.pins;

  return (
    <Box sx={{ width: 296, p: 1.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', mb: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ lineHeight: 1.3 }}>
            {definition.label}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {[spec?.manufacturer, spec?.partNumber || definition.type]
              .filter(Boolean)
              .join(' · ')}
          </Typography>
        </Box>
        <Chip
          size="small"
          label={CATEGORY_LABELS[definition.category] ?? definition.category}
          sx={{ height: 20, fontSize: 11 }}
        />
      </Stack>

      <PartPortrait definition={definition} props={props} />

      {spec?.description && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.5 }}>
          {spec.description}
        </Typography>
      )}

      {senses.length > 0 && (
        <>
          <Divider sx={{ my: 1 }} />
          <Typography variant="caption" color="text.secondary">
            Responds to {senses.map((v) => QUANTITY_LABELS[v.quantity!] ?? v.quantity).join(', ')}.
            Drag the matching object out of the interaction toolkit to trigger it.
          </Typography>
        </>
      )}

      {(limits?.vccMaxVolts !== undefined ||
        limits?.vccMinVolts !== undefined ||
        limits?.pinMaxAmps !== undefined ||
        limits?.totalMaxAmps !== undefined ||
        pins.length > 0) && <Divider sx={{ my: 1 }} />}

      <Stack spacing={0.25}>
        <Fact label="Supply" value={supplyRange(limits?.vccMinVolts, limits?.vccMaxVolts)} />
        <Fact label="Max per pin" value={milliamps(limits?.pinMaxAmps)} />
        <Fact label="Max total" value={milliamps(limits?.totalMaxAmps)} />
        <Fact
          label="Size"
          value={`${definition.width.toFixed(1)} × ${definition.height.toFixed(1)} mm`}
        />
        {pins.length > 0 && (
          <Fact
            label={pins.length === 1 ? 'Pin' : `Pins (${pins.length})`}
            // Enough to recognise the pinout, not so many that the card becomes the datasheet.
            value={
              pins.slice(0, 6).map((p) => p.name).join(', ') +
              (pins.length > 6 ? `, +${pins.length - 6}` : '')
            }
          />
        )}
      </Stack>

      {/* The caveat, where the manifest gives one. What a model leaves out is worth knowing
          before you wire the part up and trust what it reads. */}
      {spec?.notes?.[0] && (
        <>
          <Divider sx={{ my: 1 }} />
          <Typography
            variant="caption"
            color="text.secondary"
            // Clamped rather than left to run: a card taller than the window has nowhere to go,
            // and this one cannot be scrolled because it is not something the pointer can reach.
            // Built-in notes fit in three lines; a generated one is not promised to.
            sx={{
              lineHeight: 1.5,
              display: '-webkit-box',
              WebkitLineClamp: 4,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {spec.notes[0]}
          </Typography>
        </>
      )}

      {definition.provenance === 'datasheet-ai' && (
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 1 }}>
          <BoltIcon sx={{ fontSize: 14, color: 'warning.main' }} />
          <Typography variant="caption" color="warning.main">
            Read out of a datasheet by the model. Worth checking against the real one.
          </Typography>
        </Stack>
      )}

      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
        {instanceId
          ? `${instanceId} · click to open its properties`
          : 'Click the part, then click the workspace to place it'}
      </Typography>
    </Box>
  );
}
