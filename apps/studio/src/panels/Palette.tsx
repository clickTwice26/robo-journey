/**
 * Part palette and inspector.
 *
 * Categorised like Packet Tracer's device bar: pick a part, click the canvas to place it. The
 * inspector edits whatever is selected, so changing a resistor from 220R to 10k is two clicks and
 * the LED visibly dims.
 *
 * The library outgrew a flat list of buttons, so there are two ways in. Search is the fast one and
 * matches on part name and type. Browsing is the other, and the categories collapse because a
 * column of fifty buttons is a worse way to find a photoresistor than four words typed into a box
 * -- and because the inspector lives below them, and nobody should have to scroll past the whole
 * library to change a resistor value.
 */
import {
  Box,
  Button,
  Collapse,
  Divider,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import SearchIcon from '@mui/icons-material/Search';
import { useMemo, useState } from 'react';
import { allParts, partDefinition, type PartDefinition } from '@robo-journey/parts';
import { useStudio } from '../store.ts';
import { DatasheetDialog } from './DatasheetDialog.tsx';
import type { SimulationController } from '../sim/useSimulation.ts';

const CATEGORY_LABELS: Record<string, string> = {
  board: 'Boards',
  passive: 'Passives',
  output: 'Output',
  input: 'Input',
  power: 'Power',
};

/** The order the device bar reads in, rather than whatever order the registry happens to hold. */
const CATEGORY_ORDER = ['board', 'input', 'output', 'passive', 'power'];

/** A part matches a query on its name or its type, which is what people actually type. */
const matches = (part: PartDefinition, query: string): boolean =>
  part.label.toLowerCase().includes(query) || part.type.toLowerCase().includes(query);

export function PalettePanel({ sim }: { sim: SimulationController }) {
  const mode = useStudio((s) => s.mode);
  const setMode = useStudio((s) => s.setMode);
  const selection = useStudio((s) => s.selection);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Boards first and open, because that is where every project starts. The rest are one click
  // away rather than a scroll away.
  const [open, setOpen] = useState<Record<string, boolean>>({ board: true, input: true });
  // Bumping this re-reads the registry after a component is added at run time.
  const [generation, setGeneration] = useState(0);

  const needle = query.trim().toLowerCase();
  const byCategory = useMemo(() => {
    void generation;
    const map = new Map<string, PartDefinition[]>();
    for (const part of allParts()) {
      if (needle && !matches(part, needle)) continue;
      const list = map.get(part.category) ?? [];
      list.push(part);
      map.set(part.category, list);
    }
    return new Map(
      [...map].sort(
        ([a], [b]) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
      ),
    );
  }, [needle, generation]);

  const found = [...byCategory.values()].reduce((n, list) => n + list.length, 0);

  return (
    // Capped: dockview hands a closing neighbour's width to whoever is left, and a 400 px column
    // of buttons is not a better use of the space than the canvas.
    <Box sx={{ height: '100%', overflow: 'auto', p: 1, maxWidth: 260 }}>
      <Button
        fullWidth
        variant="outlined"
        color="primary"
        startIcon={<AutoAwesomeIcon />}
        onClick={() => setDialogOpen(true)}
        sx={{ mb: 1.5 }}
      >
        From datasheet
      </Button>

      <DatasheetDialog
        sim={sim}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onAdded={() => setGeneration((g) => g + 1)}
      />

      <TextField
        fullWidth
        size="small"
        placeholder="Search parts"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        sx={{ mb: 1.5 }}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 18 }} />
              </InputAdornment>
            ),
          },
        }}
      />

      {needle && found === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Nothing matches "{query}". Components can also be generated from a datasheet.
        </Typography>
      )}

      {[...byCategory].map(([category, parts]) => {
        // A search has already narrowed things down, so hiding the results behind a collapsed
        // header would undo the work the query just did.
        const expanded = Boolean(needle) || open[category] === true;
        return (
          <Box key={category} sx={{ mb: 1 }}>
            <Stack
              direction="row"
              onClick={() => setOpen((prev) => ({ ...prev, [category]: !prev[category] }))}
              sx={{ alignItems: 'center', cursor: 'pointer', userSelect: 'none', py: 0.25 }}
            >
              {expanded ? (
                <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
              ) : (
                <ChevronRightIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
              )}
              <Typography variant="overline" color="text.secondary" sx={{ flex: 1 }}>
                {CATEGORY_LABELS[category] ?? category}
              </Typography>
              <Typography variant="caption" color="text.disabled">
                {parts.length}
              </Typography>
            </Stack>

            <Collapse in={expanded} unmountOnExit>
              <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                {parts.map((part) => (
                  <Button
                    key={part.type}
                    size="small"
                    variant={
                      mode.kind === 'place' && mode.partType === part.type ? 'contained' : 'outlined'
                    }
                    onClick={() => setMode({ kind: 'place', partType: part.type })}
                    sx={{ justifyContent: 'flex-start', textAlign: 'left' }}
                    // Generated parts are marked in the palette itself, not only in the dialog that
                    // made them -- otherwise the distinction disappears the moment it matters. The
                    // built-in manifests are registered at run time too, so the mark follows
                    // provenance rather than registration.
                    endIcon={
                      part.provenance === 'datasheet-ai' ? (
                        <AutoAwesomeIcon sx={{ fontSize: 14 }} />
                      ) : undefined
                    }
                  >
                    {part.label}
                  </Button>
                ))}
              </Stack>
            </Collapse>
          </Box>
        );
      })}

      <Divider sx={{ my: 1.5 }} />
      <Inspector key={selection ?? 'none'} />
    </Box>
  );
}

function Inspector() {
  const selection = useStudio((s) => s.selection);
  const project = useStudio((s) => s.project);
  const updatePartProps = useStudio((s) => s.updatePartProps);
  const removePart = useStudio((s) => s.removePart);

  const part = project.parts.find((p) => p.id === selection);
  if (!part) {
    return (
      <Typography variant="body2" color="text.secondary">
        Select a part to edit its properties.
      </Typography>
    );
  }

  const definition = (() => {
    try {
      return partDefinition(part.type);
    } catch {
      return null;
    }
  })();

  return (
    <Stack spacing={1}>
      <Typography variant="overline" color="text.secondary">
        {definition?.label ?? part.type} · {part.id}
      </Typography>

      {part.type === 'resistor' && (
        <TextField
          label="Resistance (ohms)"
          type="number"
          value={String(part.props.ohms ?? 220)}
          onChange={(e) => {
            const ohms = Number(e.target.value);
            // Zero or negative resistance is not a component, it is a division by zero.
            if (ohms > 0) updatePartProps(part.id, { ohms });
          }}
        />
      )}

      {part.type === 'led' && (
        <TextField
          select
          label="Colour"
          value={String(part.props.color ?? 'red')}
          onChange={(e) => updatePartProps(part.id, { color: e.target.value })}
          helperText="Forward voltage follows the colour's datasheet"
        >
          {['red', 'yellow', 'green', 'blue', 'white'].map((color) => (
            <MenuItem key={color} value={color}>
              {color}
            </MenuItem>
          ))}
        </TextField>
      )}

      {part.type === 'pushbutton' && (
        <Button
          variant={part.props.pressed ? 'contained' : 'outlined'}
          onMouseDown={() => updatePartProps(part.id, { pressed: true })}
          onMouseUp={() => updatePartProps(part.id, { pressed: false })}
          onMouseLeave={() => updatePartProps(part.id, { pressed: false })}
        >
          {part.props.pressed ? 'Pressed' : 'Hold to press'}
        </Button>
      )}

      <Stack direction="row" spacing={1}>
        <TextField
          label="X (mm)"
          type="number"
          value={part.x.toFixed(2)}
          onChange={(e) => useStudio.getState().movePart(part.id, Number(e.target.value), part.y)}
        />
        <TextField
          label="Y (mm)"
          type="number"
          value={part.y.toFixed(2)}
          onChange={(e) => useStudio.getState().movePart(part.id, part.x, Number(e.target.value))}
        />
      </Stack>

      <Button
        color="error"
        variant="outlined"
        startIcon={<DeleteOutlineIcon />}
        onClick={() => removePart(part.id)}
      >
        Delete part
      </Button>
      <Typography variant="caption" color="text.secondary">
        Delete key removes the selection. Right-click a part on the canvas to unplug it without
        deleting, or right-click a wire to remove just that connection.
      </Typography>
    </Stack>
  );
}
