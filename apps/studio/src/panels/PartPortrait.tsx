/**
 * What the part looks like in the hand.
 *
 * A photograph where one exists under a licence that allows it to ship, and a drawing where one
 * does not. Both answer the same question -- "which of these in my drawer is that" -- and the
 * drawing is not a placeholder for a photograph that never arrived: for most of the small
 * Arduino modules there simply is no freely licensed photograph anywhere, and there was not going
 * to be one.
 *
 * The drawings are per *package*, not per part, because that is how components actually work.
 * Seven parts in this library are TO-92: the same black half-cylinder with three legs, and the
 * only thing that distinguishes a 2N2222 from a TMP36 in the hand is what is printed on the flat.
 * So the package is drawn once and the part number goes on the front.
 */
import { Box, Link, Typography } from '@mui/material';
import type { PartDefinition } from '@robo-journey/parts';
import photos from '../part-photos.json';

interface Credit {
  readonly file: string;
  readonly title: string;
  readonly artist: string;
  readonly licence: string;
  readonly licenceUrl: string | null;
  readonly source: string;
}

const CREDITS = photos as Record<string, Credit>;

/** Resistor colour bands, so the drawn one reads as the value it is set to. */
const BAND = [
  '#111111', '#8b4513', '#c0392b', '#e67e22', '#f1c40f',
  '#27ae60', '#2980b9', '#8e44ad', '#7f8c8d', '#ecf0f1',
];

function bandsFor(ohms: number): string[] {
  const text = Math.max(1, Math.round(ohms)).toString();
  const first = Number(text[0] ?? 2);
  const second = Number(text[1] ?? 2);
  const zeros = Math.max(0, text.length - 2);
  return [BAND[first]!, BAND[second]!, BAND[Math.min(9, zeros)]!];
}

/**
 * One drawing per package.
 *
 * Proportions come from the mechanical drawing in the datasheet rather than from what looks right,
 * which is why the TO-220's tab is that big and the DIP's notch is on that end.
 */
function PackageDrawing({ definition, props }: { definition: PartDefinition; props: Record<string, unknown> }) {
  const type = definition.appearance?.packageType ?? '';
  const body = definition.appearance?.bodyColor ?? '#2b3038';
  const label = definition.appearance?.title ?? definition.label;
  const lead = '#c8ccd2';
  const shadow = '#00000055';

  const legs = (xs: number[], top: number, height = 26) =>
    xs.map((x) => <rect key={x} x={x - 1.6} y={top} width={3.2} height={height} rx={1} fill={lead} />);

  if (/^TO-92/i.test(type)) {
    return (
      <svg viewBox="0 0 160 120" width="100%" height="100%">
        {legs([64, 80, 96], 74)}
        {/* Half-cylinder: round at the back, flat at the front, which is where the marking goes. */}
        <path d="M 50 30 A 30 30 0 0 1 110 30 L 110 74 L 50 74 Z" fill={body} stroke={shadow} />
        <path d="M 50 62 L 110 62 L 110 74 L 50 74 Z" fill="#000" opacity={0.18} />
        <text x={80} y={52} textAnchor="middle" fontSize={13} fill="#cfd6df" fontFamily="ui-monospace, monospace">
          {label.slice(0, 8)}
        </text>
      </svg>
    );
  }

  if (/^TO-220/i.test(type)) {
    return (
      <svg viewBox="0 0 160 120" width="100%" height="100%">
        {legs([64, 80, 96], 82, 24)}
        {/* The tab, and the hole through it that a heatsink screw goes in. */}
        <rect x={48} y={14} width={64} height={22} rx={2} fill="#9aa4b0" stroke={shadow} />
        <circle cx={80} cy={25} r={5} fill="#5b6472" />
        <rect x={48} y={34} width={64} height={48} rx={2} fill={body} stroke={shadow} />
        <text x={80} y={62} textAnchor="middle" fontSize={12} fill="#cfd6df" fontFamily="ui-monospace, monospace">
          {label.slice(0, 9)}
        </text>
      </svg>
    );
  }

  if (/^DIP-(\d+)/i.test(type)) {
    const pins = Number(/^DIP-(\d+)/i.exec(type)![1]);
    const perSide = Math.max(2, Math.floor(pins / 2));
    const step = 104 / perSide;
    const xs = Array.from({ length: perSide }, (_, i) => 28 + step / 2 + i * step);
    return (
      <svg viewBox="0 0 160 120" width="100%" height="100%">
        {xs.map((x) => <rect key={`t${x}`} x={x - 1.8} y={22} width={3.6} height={12} fill={lead} />)}
        {xs.map((x) => <rect key={`b${x}`} x={x - 1.8} y={86} width={3.6} height={12} fill={lead} />)}
        <rect x={26} y={34} width={108} height={52} rx={3} fill={body} stroke={shadow} />
        {/* The notch, which is the only thing telling you which end pin 1 is. */}
        <path d="M 26 52 A 9 9 0 0 0 26 68 Z" fill="#0a0c0f" />
        <text x={86} y={64} textAnchor="middle" fontSize={12} fill="#cfd6df" fontFamily="ui-monospace, monospace">
          {label.slice(0, 10)}
        </text>
      </svg>
    );
  }

  if (/^SOT-223/i.test(type)) {
    return (
      <svg viewBox="0 0 160 120" width="100%" height="100%">
        <rect x={44} y={72} width={20} height={12} fill={lead} />
        <rect x={72} y={72} width={20} height={12} fill={lead} />
        <rect x={100} y={72} width={20} height={12} fill={lead} />
        <rect x={54} y={34} width={56} height={16} rx={1} fill="#9aa4b0" />
        <rect x={46} y={40} width={72} height={34} rx={2} fill={body} stroke={shadow} />
        <text x={82} y={62} textAnchor="middle" fontSize={10} fill="#cfd6df" fontFamily="ui-monospace, monospace">
          {label.slice(0, 10)}
        </text>
      </svg>
    );
  }

  if (/^radial/i.test(type)) {
    // Electrolytics are polarised and marked; the drawing shows the stripe because getting that
    // the wrong way round is how they fail.
    const polarised = definition.pins.some((p) => p.name === '-');
    return (
      <svg viewBox="0 0 160 120" width="100%" height="100%">
        {legs([72, 88], 84, 22)}
        <rect x={54} y={22} width={52} height={62} rx={7} fill={body} stroke={shadow} />
        <ellipse cx={80} cy={24} rx={26} ry={6} fill="#ffffff" opacity={0.12} />
        {polarised && (
          <>
            <rect x={54} y={22} width={13} height={62} fill="#d8dde5" opacity={0.85} />
            <text x={60} y={58} textAnchor="middle" fontSize={13} fill="#111" fontFamily="sans-serif">−</text>
          </>
        )}
        <text x={90} y={58} textAnchor="middle" fontSize={11} fill="#e6ebf2" fontFamily="ui-monospace, monospace">
          {label.slice(0, 7)}
        </text>
      </svg>
    );
  }

  if (/^DO-(35|41)/i.test(type)) {
    const glass = /DO-35/i.test(type);
    return (
      <svg viewBox="0 0 160 120" width="100%" height="100%">
        <rect x={10} y={57} width={44} height={4} fill={lead} />
        <rect x={106} y={57} width={44} height={4} fill={lead} />
        <rect x={54} y={44} width={52} height={30} rx={glass ? 12 : 4} fill={body} stroke={shadow} />
        {/* The band marks the cathode. It is the entire user interface of a diode. */}
        <rect x={94} y={44} width={8} height={30} fill="#e6ebf2" />
        <text x={74} y={63} textAnchor="middle" fontSize={10} fill="#cfd6df" fontFamily="ui-monospace, monospace">
          {label.slice(0, 6)}
        </text>
      </svg>
    );
  }

  if (definition.type === 'resistor') {
    const bands = bandsFor(Number(props.ohms ?? 220));
    return (
      <svg viewBox="0 0 160 120" width="100%" height="100%">
        <rect x={8} y={57} width={48} height={4} fill={lead} />
        <rect x={104} y={57} width={48} height={4} fill={lead} />
        <rect x={52} y={44} width={56} height={30} rx={13} fill="#d9c9a3" stroke={shadow} />
        {bands.map((colour, i) => (
          <rect key={i} x={60 + i * 11} y={44} width={7} height={30} fill={colour} />
        ))}
        <rect x={96} y={44} width={6} height={30} fill="#c9a227" />
      </svg>
    );
  }

  if (/^trimmer/i.test(type)) {
    return (
      <svg viewBox="0 0 160 120" width="100%" height="100%">
        {legs([62, 80, 98], 78, 24)}
        <rect x={48} y={30} width={64} height={48} rx={3} fill="#1b62b3" stroke={shadow} />
        <circle cx={80} cy={50} r={15} fill="#e8e2cf" stroke="#0006" />
        <rect x={72} y={48} width={16} height={4} rx={1} fill="#4a4a4a" />
      </svg>
    );
  }

  // Everything else is a breakout board: a small PCB with a header along one edge and the
  // interesting component in the middle. Which is, in fairness, what most of them are.
  const headerPins = Math.min(8, Math.max(3, definition.pins.length));
  return (
    <svg viewBox="0 0 160 120" width="100%" height="100%">
      <rect x={26} y={20} width={108} height={80} rx={4} fill={body} stroke={shadow} />
      <rect x={30} y={24} width={100} height={72} rx={3} fill="#ffffff" opacity={0.04} />
      {/* Mounting holes, because every one of these boards has them. */}
      <circle cx={34} cy={28} r={3} fill="#0a0c0f" />
      <circle cx={126} cy={28} r={3} fill="#0a0c0f" />
      <rect x={58} y={40} width={44} height={26} rx={2} fill="#101418" />
      <text x={80} y={57} textAnchor="middle" fontSize={9} fill="#8fa0b4" fontFamily="ui-monospace, monospace">
        {label.slice(0, 9)}
      </text>
      {/* The header. Black plastic, brass pins. */}
      <rect x={44} y={82} width={72} height={12} rx={1.5} fill="#15181d" />
      {Array.from({ length: headerPins }, (_, i) => (
        <rect
          key={i}
          x={48 + i * (64 / headerPins)}
          y={85}
          width={4}
          height={6}
          fill="#d9b25a"
        />
      ))}
    </svg>
  );
}

export function PartPortrait({
  definition,
  props,
}: {
  definition: PartDefinition;
  props: Record<string, unknown>;
}) {
  const credit = CREDITS[definition.type];

  return (
    <Box sx={{ mb: 2 }}>
      <Box
        sx={{
          height: 128,
          borderRadius: 1.5,
          border: 1,
          borderColor: 'divider',
          bgcolor: 'action.hover',
          display: 'grid',
          placeItems: 'center',
          overflow: 'hidden',
          p: credit ? 0 : 1,
        }}
      >
        {credit ? (
          <Box
            component="img"
            src={credit.file}
            alt={`${definition.label} — ${credit.title}`}
            // Eager, not lazy. The element only exists once something is showing it, so deferring
            // buys nothing -- and on the hover card, which is on screen for about a second, a
            // deferred image is an empty grey box for the whole time anyone looks at it.
            loading="eager"
            decoding="async"
            sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <PackageDrawing definition={definition} props={props} />
        )}
      </Box>

      {/* The credit is not optional. These are Creative Commons photographs and most of the
          licences require attribution; showing it here is what makes them usable at all. */}
      {credit ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, lineHeight: 1.5 }}>
          <Link href={credit.source} target="_blank" rel="noreferrer noopener" underline="hover">
            {credit.title}
          </Link>{' '}
          · {credit.artist} ·{' '}
          {credit.licenceUrl ? (
            <Link href={credit.licenceUrl} target="_blank" rel="noreferrer noopener" underline="hover">
              {credit.licence}
            </Link>
          ) : (
            credit.licence
          )}
        </Typography>
      ) : (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          Drawn from the {definition.appearance?.packageType ?? 'package'} outline — no freely
          licensed photograph of this part exists.
        </Typography>
      )}
    </Box>
  );
}
