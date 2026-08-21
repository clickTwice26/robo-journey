/**
 * What you can do to several parts at once.
 *
 * Selecting six things and asking the inspector to show "the" resistance is not a question with an
 * answer, so this replaces it rather than disabling it. Everything here is an operation that only
 * means something in the plural: line these up, space these out, turn these, copy these.
 *
 * Alignment matters more than it sounds. A workspace people actually build on drifts crooked, and
 * straightening six parts by hand is the sort of work a tool should be doing.
 */
import { Box, Button, Divider, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import AlignHorizontalLeftIcon from '@mui/icons-material/AlignHorizontalLeft';
import AlignHorizontalCenterIcon from '@mui/icons-material/AlignHorizontalCenter';
import AlignHorizontalRightIcon from '@mui/icons-material/AlignHorizontalRight';
import AlignVerticalTopIcon from '@mui/icons-material/AlignVerticalTop';
import AlignVerticalCenterIcon from '@mui/icons-material/AlignVerticalCenter';
import AlignVerticalBottomIcon from '@mui/icons-material/AlignVerticalBottom';
// This icon set has no distribute glyphs. Columns and rows carry the same idea -- equal gaps
// across, equal gaps down -- and are at least honest about which axis they mean.
import ViewColumnIcon from '@mui/icons-material/ViewColumn';
import TableRowsIcon from '@mui/icons-material/TableRows';
import Rotate90DegreesCwIcon from '@mui/icons-material/Rotate90DegreesCw';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import { partDefinition } from '@robo-journey/parts';
import { useStudio } from '../store.ts';
import { boundsOf, boxOf, type Arrangement } from '../canvas/arrange.ts';

const ALIGN: { how: Arrangement; label: string; icon: React.ReactElement }[] = [
  { how: 'left', label: 'Align left edges', icon: <AlignHorizontalLeftIcon fontSize="small" /> },
  { how: 'centre-x', label: 'Centre horizontally', icon: <AlignHorizontalCenterIcon fontSize="small" /> },
  { how: 'right', label: 'Align right edges', icon: <AlignHorizontalRightIcon fontSize="small" /> },
  { how: 'top', label: 'Align top edges', icon: <AlignVerticalTopIcon fontSize="small" /> },
  { how: 'centre-y', label: 'Centre vertically', icon: <AlignVerticalCenterIcon fontSize="small" /> },
  { how: 'bottom', label: 'Align bottom edges', icon: <AlignVerticalBottomIcon fontSize="small" /> },
];

const DISTRIBUTE: { how: Arrangement; label: string; icon: React.ReactElement }[] = [
  { how: 'space-x', label: 'Space evenly across', icon: <ViewColumnIcon fontSize="small" /> },
  { how: 'space-y', label: 'Space evenly down', icon: <TableRowsIcon fontSize="small" /> },
];

/** A row of icon buttons that all do the same kind of thing. */
function Tools({
  tools,
  disabled,
  onPick,
}: {
  tools: typeof ALIGN;
  disabled?: boolean;
  onPick: (how: Arrangement) => void;
}) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
      {tools.map((tool) => (
        <Tooltip key={tool.how} title={tool.label}>
          {/* A disabled button swallows its own hover, so the tooltip needs something that is not
              disabled to sit on. */}
          <span>
            <IconButton
              size="small"
              disabled={disabled}
              onClick={() => onPick(tool.how)}
              sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}
            >
              {tool.icon}
            </IconButton>
          </span>
        </Tooltip>
      ))}
    </Stack>
  );
}

export function MultiSelection({ ids }: { ids: readonly string[] }) {
  const project = useStudio((s) => s.project);
  const arrangeSelection = useStudio((s) => s.arrangeSelection);
  const rotateSelection = useStudio((s) => s.rotateSelection);
  const duplicateSelection = useStudio((s) => s.duplicateSelection);
  const removeSelection = useStudio((s) => s.removeSelection);
  const removeWire = useStudio((s) => s.removeWire);
  const setSelection = useStudio((s) => s.setSelection);

  const chosen = new Set(ids);
  const parts = project.parts.filter((p) => chosen.has(p.id));
  if (parts.length === 0) return null;

  const bounds = boundsOf(parts.map(boxOf));

  // What is in the selection, by kind, so it reads as "3 LEDs, 2 resistors" rather than "5 parts".
  const counts = new Map<string, number>();
  for (const part of parts) {
    let label = part.type;
    try {
      label = partDefinition(part.type).label;
    } catch {
      // An unregistered type still has to be countable; its own name is the best available label.
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  /** Wires from the selection to anything outside it. Internal ones are part of the subassembly. */
  const owner = (terminal: string) => terminal.slice(0, terminal.indexOf(':'));
  const crossing = project.wires.filter(
    (w) => chosen.has(owner(w.from)) !== chosen.has(owner(w.to)),
  );

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography variant="overline" color="text.secondary">
          {parts.length} parts selected
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.6 }}>
          {[...counts]
            .sort((a, b) => b[1] - a[1])
            .map(([label, n]) => (n > 1 ? `${n} × ${label}` : label))
            .join(', ')}
        </Typography>
      </Box>

      <Divider />

      <Box>
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 0.75 }}>
          Align
        </Typography>
        <Tools tools={ALIGN} onPick={arrangeSelection} />
      </Box>

      <Box>
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 0.75 }}>
          Distribute
        </Typography>
        {/* Two parts have no gap between them to equalise -- the extremes are the whole set. */}
        <Tools tools={DISTRIBUTE} disabled={parts.length < 3} onPick={arrangeSelection} />
        {parts.length < 3 && (
          <Typography variant="caption" color="text.disabled">
            Needs three or more.
          </Typography>
        )}
      </Box>

      <Divider />

      <Stack direction="row" spacing={1}>
        <Button
          size="small"
          variant="outlined"
          fullWidth
          startIcon={<Rotate90DegreesCwIcon fontSize="small" />}
          onClick={() => rotateSelection(90)}
        >
          Rotate
        </Button>
        <Button
          size="small"
          variant="outlined"
          fullWidth
          startIcon={<ContentCopyIcon fontSize="small" />}
          onClick={duplicateSelection}
        >
          Duplicate
        </Button>
      </Stack>

      <Button
        size="small"
        variant="outlined"
        fullWidth
        disabled={crossing.length === 0}
        startIcon={<LinkOffIcon fontSize="small" />}
        onClick={() => {
          for (const wire of crossing) removeWire(wire.id);
        }}
      >
        Unplug {crossing.length > 0 ? `(${crossing.length})` : ''}
      </Button>
      <Typography variant="caption" color="text.disabled" sx={{ mt: -1 }}>
        Cuts only the {crossing.length === 1 ? 'wire' : 'wires'} leaving the selection. Wires
        between two selected parts stay, so a subassembly comes away whole.
      </Typography>

      <Divider />

      <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary">
          Occupies
        </Typography>
        <Typography variant="caption">
          {bounds.width.toFixed(1)} × {bounds.height.toFixed(1)} mm
        </Typography>
      </Stack>

      <Button
        size="small"
        color="error"
        variant="outlined"
        startIcon={<DeleteOutlineIcon fontSize="small" />}
        onClick={removeSelection}
      >
        Delete {parts.length} parts
      </Button>

      <Button size="small" onClick={() => setSelection(null)}>
        Deselect
      </Button>
    </Stack>
  );
}
