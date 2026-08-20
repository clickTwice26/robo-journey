/**
 * Properties of whatever is selected.
 *
 * Its own panel rather than a strip under the parts list, because the two are used at different
 * moments: you reach for the palette when you are building and for this when you are adjusting,
 * and stacking them meant scrolling past the whole library to change a resistor.
 *
 * Most of what is here is generated rather than written. A part declares what it senses and a
 * stimulus declares what it emits, so both get working controls without anyone adding a case --
 * which is what lets a component extracted from a datasheet this afternoon be adjustable this
 * afternoon.
 */
import {
  Box,
  Button,
  Divider,
  IconButton,
  Tooltip,
  FormControlLabel,
  MenuItem,
  Slider,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import Rotate90DegreesCwIcon from '@mui/icons-material/Rotate90DegreesCw';
import {
  EMISSIONS,
  partDefinition,
  type PartDefinition,
  type PartInstance,
} from '@robo-journey/parts';
import { useStudio } from '../store.ts';

export function PropertiesPanel() {
  const selection = useStudio((s) => s.selection);
  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 1.5 }}>
      <Inspector key={selection ?? 'none'} />
    </Box>
  );
}

/**
 * Sliders for whatever the world supplies a part.
 *
 * Every sensor in the library declares what it senses, so this is one control per declared
 * quantity rather than a hand-written panel per part -- which is why a component extracted from a
 * datasheet this afternoon gets working controls without anyone touching the UI.
 *
 * A quantity the toolkit is currently driving shows the value it is being given and says where it
 * came from. The slider stays live underneath, because it is the *ambient* level the stimulus adds
 * to: a lamp brightens a room that already had some light in it.
 */
function SensorControls({
  part,
  definition,
}: {
  part: PartInstance;
  definition: PartDefinition | null;
}) {
  const updatePartProps = useStudio((s) => s.updatePartProps);
  const driven = useStudio((s) => s.snapshot.driven[part.id]);
  const variables = definition?.state ?? [];
  if (variables.length === 0) return null;

  return (
    <Stack spacing={1.5} sx={{ pt: 0.5 }}>
      {variables.map((variable) => {
        const ambient =
          typeof part.props[variable.name] === 'number'
            ? (part.props[variable.name] as number)
            : variable.default;
        const supplied = driven?.[variable.name];

        return (
          <Box key={variable.name}>
            <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
              <Typography variant="caption" color="text.secondary">
                {variable.label}
              </Typography>
              <Typography variant="caption" color={supplied === undefined ? 'text.primary' : 'primary.main'}>
                {(supplied ?? ambient).toFixed(variable.step < 1 ? 2 : 0)} {variable.unit}
              </Typography>
            </Stack>
            <Slider
              size="small"
              min={variable.min}
              max={variable.max}
              step={variable.step}
              value={ambient}
              onChange={(_, value) =>
                updatePartProps(part.id, { [variable.name]: value as number })
              }
            />
            {supplied !== undefined && (
              <Typography variant="caption" color="primary.main">
                Driven by the toolkit; the slider sets the ambient level it adds to.
              </Typography>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}

/**
 * Controls for a placed stimulus.
 *
 * Generated from what the object emits, so a flame gets four sliders because a flame really is
 * four things at once, and adding a new stimulus needs no UI work at all.
 */
function StimulusControls({
  part,
  definition,
}: {
  part: PartInstance;
  definition: PartDefinition | null;
}) {
  const updatePartProps = useStudio((s) => s.updatePartProps);
  const emissions = EMISSIONS[part.type];
  if (!emissions || !definition) return null;

  const on = part.props.on !== false;
  // One reach serves every emission a source has, so it is edited once rather than four times.
  const reach = Number(part.props.reachMm ?? definition.defaults.reachMm ?? 30);

  return (
    <Stack spacing={1.5}>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={on}
            onChange={(e) => updatePartProps(part.id, { on: e.target.checked })}
          />
        }
        label={on ? 'On' : 'Off'}
      />

      <Box>
        <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Typography variant="caption" color="text.secondary">
            Reach (half strength)
          </Typography>
          <Typography variant="caption">{reach.toFixed(0)} mm</Typography>
        </Stack>
        <Slider
          size="small"
          min={5}
          max={400}
          step={5}
          value={reach}
          onChange={(_, value) => updatePartProps(part.id, { reachMm: value as number })}
        />
      </Box>

      {emissions.map((emission) => {
        const value = Number(
          part.props[emission.intensityProp] ?? definition.defaults[emission.intensityProp] ?? 0,
        );
        const fallback = Number(definition.defaults[emission.intensityProp] ?? 1);
        // Range from the object's own default, so a flame's 2500 ppm of smoke and its 1.0 of
        // infrared each get a scale that suits them.
        const max = Math.max(1, fallback * 2);

        return (
          <Box key={emission.quantity}>
            <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
              <Typography variant="caption" color="text.secondary">
                {QUANTITY_LABELS[emission.quantity] ?? emission.quantity}
              </Typography>
              <Typography variant="caption">
                {value.toFixed(max <= 2 ? 2 : 0)}
              </Typography>
            </Stack>
            <Slider
              size="small"
              min={0}
              max={max}
              step={max <= 2 ? 0.05 : Math.max(1, Math.round(max / 100))}
              value={value}
              onChange={(_, v) => updatePartProps(part.id, { [emission.intensityProp]: v as number })}
            />
          </Box>
        );
      })}

      <Typography variant="caption" color="text.secondary">
        Drag it near a sensor. One millimetre on the canvas stands for a centimetre of world, so a
        rangefinder pointed at an obstacle 40 mm away reads 40 cm.
      </Typography>
    </Stack>
  );
}

const QUANTITY_LABELS: Record<string, string> = {
  light: 'Light (lux)',
  sound: 'Loudness (dB)',
  temperature: 'Heat (C above ambient)',
  flame: 'Infrared',
  motion: 'Movement',
  magnet: 'Field strength',
  distance: 'Solidity',
  gas: 'Smoke (ppm)',
  moisture: 'Wetness (%)',
  vibration: 'Shake',
};

function Inspector() {
  const selection = useStudio((s) => s.selection);
  const project = useStudio((s) => s.project);
  const updatePartProps = useStudio((s) => s.updatePartProps);
  const removePart = useStudio((s) => s.removePart);
  const rotatePart = useStudio((s) => s.rotatePart);

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
          helperText="Forward voltage follows the colour: 1.4 V infrared to 3.4 V UV"
        >
          {['infrared', 'red', 'orange', 'yellow', 'green', 'blue', 'white', 'uv'].map((color) => (
            <MenuItem key={color} value={color}>
              {color}
            </MenuItem>
          ))}
        </TextField>
      )}

      <StimulusControls part={part} definition={definition} />

      <SensorControls part={part} definition={definition} />

      {part.type === 'multimeter' && (
        <>
          <TextField
            select
            label="Dial"
            value={String(part.props.mode ?? 'volts')}
            onChange={(e) => updatePartProps(part.id, { mode: e.target.value })}
            helperText="The current jack is live whatever the dial says"
          >
            <MenuItem value="volts">DC voltage</MenuItem>
            <MenuItem value="amps">DC current</MenuItem>
            <MenuItem value="ohms">Resistance</MenuItem>
          </TextField>
          <TextField
            select
            label="Current jack"
            value={String(part.props.range ?? 'mA')}
            onChange={(e) => updatePartProps(part.id, { range: e.target.value })}
            helperText="mA fuses at 200 mA; A fuses at 10 A"
          >
            <MenuItem value="mA">mA (1 ohm shunt)</MenuItem>
            <MenuItem value="A">A (0.01 ohm shunt)</MenuItem>
          </TextField>
        </>
      )}

      {part.type === 'ammeter' && (
        <TextField
          select
          label="Range"
          value={String(part.props.range ?? 'mA')}
          onChange={(e) => updatePartProps(part.id, { range: e.target.value })}
          helperText="Wire it in series. Across a supply, the fuse goes."
        >
          <MenuItem value="mA">mA (1 ohm shunt)</MenuItem>
          <MenuItem value="A">A (0.01 ohm shunt)</MenuItem>
        </TextField>
      )}

      {part.type === 'oscilloscope' && (
        <>
          <TextField
            select
            label="Timebase"
            value={String(part.props.span ?? 0.05)}
            onChange={(e) => updatePartProps(part.id, { span: Number(e.target.value) })}
            helperText="Seconds across the whole screen"
          >
            {[0.001, 0.005, 0.02, 0.05, 0.2, 1, 2].map((seconds) => (
              <MenuItem key={seconds} value={String(seconds)}>
                {seconds >= 1 ? `${seconds} s` : `${seconds * 1000} ms`}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Volts per division"
            value={String(part.props.voltsPerDiv ?? 1)}
            onChange={(e) => updatePartProps(part.id, { voltsPerDiv: Number(e.target.value) })}
          >
            {[0.1, 0.2, 0.5, 1, 2, 5].map((volts) => (
              <MenuItem key={volts} value={String(volts)}>
                {volts} V
              </MenuItem>
            ))}
          </TextField>
          <Typography variant="caption" color="text.secondary">
            Run the GND clip to circuit ground. Without it the probes have nothing to measure
            against and the traces float, exactly as they would on the bench.
          </Typography>
        </>
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

      {/* Rotation is what aims a directional sensor, so it sits with position rather than buried
          in a menu. Ninety degree steps because that is how parts go onto a bench; the field takes
          anything for the cases where it does not. */}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <TextField
          label="Facing (deg)"
          type="number"
          value={String(Math.round(part.rotation))}
          onChange={(e) => rotatePart(part.id, Number(e.target.value) || 0)}
          helperText="0 points up the workspace"
          sx={{ flex: 1 }}
        />
        <Tooltip title="Turn 90 degrees (R)">
          <IconButton onClick={() => rotatePart(part.id, part.rotation + 90)}>
            <Rotate90DegreesCwIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

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
