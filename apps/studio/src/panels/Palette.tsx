/**
 * Part palette and inspector.
 *
 * Categorised like Packet Tracer's device bar: pick a part, click the canvas to place it. The
 * inspector below edits whatever is selected, so changing a resistor from 220R to 10k is two
 * clicks and the LED visibly dims.
 */
import {
  Box,
  Button,
  Divider,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import { allParts, partDefinition } from '@robo-journey/parts';
import { useStudio } from '../store.ts';

const CATEGORY_LABELS: Record<string, string> = {
  board: 'Boards',
  passive: 'Passives',
  output: 'Output',
  input: 'Input',
  power: 'Power',
};

export function PalettePanel() {
  const mode = useStudio((s) => s.mode);
  const setMode = useStudio((s) => s.setMode);

  const byCategory = new Map<string, ReturnType<typeof allParts>[number][]>();
  for (const part of allParts()) {
    const list = byCategory.get(part.category) ?? [];
    list.push(part);
    byCategory.set(part.category, list);
  }

  return (
    // Capped: dockview hands a closing neighbour's width to whoever is left, and a 400 px column
    // of buttons is not a better use of the space than the canvas.
    <Box sx={{ height: '100%', overflow: 'auto', p: 1, maxWidth: 260 }}>
      {[...byCategory].map(([category, parts]) => (
        <Box key={category} sx={{ mb: 1.5 }}>
          <Typography variant="overline" color="text.secondary">
            {CATEGORY_LABELS[category] ?? category}
          </Typography>
          <Stack spacing={0.5} sx={{ mt: 0.5 }}>
            {parts.map((part) => (
              <Button
                key={part.type}
                variant={mode.kind === 'place' && mode.partType === part.type ? 'contained' : 'outlined'}
                onClick={() => setMode({ kind: 'place', partType: part.type })}
                sx={{ justifyContent: 'flex-start' }}
              >
                {part.label}
              </Button>
            ))}
          </Stack>
        </Box>
      ))}

      <Divider sx={{ my: 1.5 }} />
      <Inspector />
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
