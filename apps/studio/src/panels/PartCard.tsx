/**
 * What a part is, on hover.
 *
 * The palette is a column of names, and a name is not enough to choose by: "SW-420" tells you
 * nothing until you have already placed one and read the Properties panel. The canvas has the
 * opposite problem -- the artwork is a footprint drawn to scale, which is the right thing for
 * wiring and the wrong thing for recognising a component.
 *
 * So this is the answer to "what is that": the photograph, the one-line description off the
 * datasheet, and the numbers that decide whether the part survives being wired up wrong. A part
 * that is actually on the workspace gets its own readings on top -- what the world is doing to it
 * right now and how it is set -- so hovering answers "what is this doing" without having to
 * select it first and read the panel on the far side of the screen.
 *
 * Read-only throughout. Clicking still opens the Properties panel, which is where a part is
 * changed; a card you cannot reach cannot have a slider on it.
 */
import { Box, Chip, Divider, Stack, Typography } from '@mui/material';
import BoltIcon from '@mui/icons-material/Bolt';
import { EMISSIONS, type PartDefinition, type PartInstance } from '@robo-journey/parts';
import { PartPortrait } from './PartPortrait.tsx';
import { useStudio } from '../store.ts';

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

/**
 * How a part's own settings read.
 *
 * Named rather than derived from the key, because `heatC` and `smokePpm` are the names the
 * manifest uses and not the words anybody says. Anything not listed -- a component extracted from
 * a datasheet this morning -- falls back to its key split into words, which is worse but never
 * wrong.
 */
const PROP_LABELS: Record<string, { label: string; unit?: string }> = {
  amplitude: { label: 'Amplitude' },
  color: { label: 'Colour' },
  db: { label: 'Loudness', unit: 'dB' },
  flame: { label: 'Infrared' },
  fuseBlown: { label: 'Fuse' },
  heatC: { label: 'Heat', unit: '°C' },
  lux: { label: 'Brightness', unit: 'lux' },
  mode: { label: 'Dial' },
  moisture: { label: 'Wetness', unit: '%' },
  moving: { label: 'Movement' },
  offsetVolts: { label: 'Offset', unit: 'V' },
  ohms: { label: 'Resistance', unit: 'Ω' },
  on: { label: 'Switched' },
  present: { label: 'Presence' },
  pressed: { label: 'Button' },
  range: { label: 'Range' },
  reachMm: { label: 'Reach', unit: 'mm' },
  smokePpm: { label: 'Smoke', unit: 'ppm' },
  span: { label: 'Span' },
  strength: { label: 'Strength' },
  voltsPerDiv: { label: 'Volts/div', unit: 'V' },
};

/** "a, b and c" -- a comma before the last item reads as a missing word, not a list. */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** `reachMm` -> "Reach mm". Only ever reached by a part this build has never seen. */
function humanise(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Booleans read as words, because "true" is not a setting anybody recognises. */
function readValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') {
    if (key === 'fuseBlown') return value ? 'blown' : 'intact';
    if (key === 'pressed') return value ? 'pressed' : 'released';
    return value ? 'on' : 'off';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

/** A row of `label — value`, skipped entirely when there is no value to show. */
function Fact({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string | undefined;
  highlight?: boolean;
}) {
  if (!value) return null;
  return (
    <Stack direction="row" spacing={1} sx={{ justifyContent: 'space-between' }}>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography
        variant="caption"
        color={highlight ? 'primary.main' : 'text.primary'}
        sx={{ textAlign: 'right' }}
      >
        {value}
      </Typography>
    </Stack>
  );
}

/** A small heading over a group of rows. */
function Section({ title }: { title: string }) {
  return (
    <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1, mb: 0.25 }}>
      {title}
    </Typography>
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
  /** The part on the workspace, when the card is describing one rather than a palette entry. */
  instance,
}: {
  definition: PartDefinition;
  instance?: PartInstance;
}) {
  // Only what this part is being handed by the world, so the card re-renders with the readings
  // and the panel hosting it does not. Subscribing any higher would redraw the canvas every frame.
  const driven = useStudio((s) => (instance ? s.snapshot.driven[instance.id] : undefined));

  const spec = definition.spec;
  const limits = spec?.limits;
  const props = instance?.props ?? {};
  const variables = definition.state ?? [];
  const senses = variables.filter((v) => v.quantity);
  const pins = definition.pins;

  // The part's own dials, which is everything it carries that is not a reading.
  const isStimulus = definition.category === 'stimulus';
  // What a source puts into the world, in the same plain words the sensors are described with.
  const emits = (EMISSIONS[definition.type] ?? []).map(
    (e) => QUANTITY_LABELS[e.quantity] ?? e.quantity,
  );

  const stateNames = new Set(variables.map((v) => v.name));
  const settings = Object.entries({ ...definition.defaults, ...props })
    .filter(([key]) => !stateNames.has(key))
    .sort(([a], [b]) => a.localeCompare(b));

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

      {/* A flame is not a component and has no package, so the drawing that stands in for a
          missing photograph would be a picture of something that does not exist. What it puts
          into the world is the useful thing to say about it instead. */}
      {isStimulus ? (
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.5 }}>
          Put this near a sensor to trigger it. Everything within its reach is given{' '}
          {list(emits)}, weaker the further away it is.
        </Typography>
      ) : (
        <>
          <PartPortrait definition={definition} props={props} />
          {spec?.description && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.5 }}>
              {spec.description}
            </Typography>
          )}
        </>
      )}

      {/* Readings first, for a part that is on the workspace: what it is doing now is the reason
          you put the pointer on it, and what it is rated for can wait until further down. */}
      {instance && variables.length > 0 && (
        <>
          <Divider sx={{ mt: 1 }} />
          <Section title="Reading now" />
          <Stack spacing={0.25}>
            {variables.map((variable) => {
              const supplied = driven?.[variable.name];
              const set =
                typeof props[variable.name] === 'number'
                  ? (props[variable.name] as number)
                  : variable.default;
              const value = supplied ?? set;
              return (
                <Fact
                  key={variable.name}
                  label={variable.label}
                  value={
                    `${value.toFixed(variable.step < 1 ? 2 : 0)}${
                      variable.unit ? ` ${variable.unit}` : ''
                    }` + (supplied !== undefined ? ' · from the toolkit' : '')
                  }
                  highlight={supplied !== undefined}
                />
              );
            })}
          </Stack>
        </>
      )}

      {instance && settings.length > 0 && (
        <>
          <Section title="Set to" />
          <Stack spacing={0.25}>
            {settings.map(([key, value]) => (
              <Fact
                key={key}
                label={PROP_LABELS[key]?.label ?? humanise(key)}
                value={`${readValue(key, value)}${
                  PROP_LABELS[key]?.unit ? ` ${PROP_LABELS[key]!.unit}` : ''
                }`}
              />
            ))}
          </Stack>
        </>
      )}

      {/* On a palette entry there is nothing to read yet, so say what the part responds to
          instead -- which is the thing you are choosing it for. */}
      {!instance && senses.length > 0 && (
        <>
          <Divider sx={{ my: 1 }} />
          <Typography variant="caption" color="text.secondary">
            Responds to {list(senses.map((v) => QUANTITY_LABELS[v.quantity!] ?? String(v.quantity)))}.
            Drag the matching object out of the interaction toolkit to trigger it.
          </Typography>
        </>
      )}

      {/* Nothing about a flame is rated, and its footprint is not a fact about it, so a source
          skips this whole block rather than printing headings over empty rows. */}
      {!isStimulus && (
        <>
          <Divider sx={{ mt: 1 }} />
          {instance && <Section title="Rated for" />}
          <Stack spacing={0.25} sx={{ mt: instance ? 0 : 1 }}>
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
                // Enough to recognise the pinout, not so many that the card becomes a datasheet.
                value={
                  pins.slice(0, 6).map((p) => p.name).join(', ') +
                  (pins.length > 6 ? `, +${pins.length - 6}` : '')
                }
              />
            )}
          </Stack>
        </>
      )}

      {instance && (
        <>
          <Divider sx={{ mt: 1 }} />
          <Section title="On the workspace" />
          <Stack spacing={0.25}>
            <Fact label="Turned" value={`${instance.rotation}°`} />
            <Fact label="At" value={`${instance.x.toFixed(1)}, ${instance.y.toFixed(1)} mm`} />
          </Stack>
        </>
      )}

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
        {instance
          ? `${instance.id} · click to change any of this`
          : 'Click the part, then click the workspace to place it'}
      </Typography>
    </Box>
  );
}
