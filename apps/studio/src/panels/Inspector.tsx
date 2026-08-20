/**
 * Inspector: what is going on inside the chip, and inside the parts around it.
 *
 * Registers by name with their bits spelled out, rather than a hex dump. `DDRB = 0x20` makes you
 * go and look it up; `DDB5` lit means D13 is an output, which is the thing you actually wanted to
 * know. Named registers are the difference between a memory viewer and a debugger.
 *
 * Parts come first, because a regulator's junction temperature is not something a probe can reach
 * and it is usually the reason someone opened this panel.
 */
import {
  Box,
  Chip,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import { useStudio } from '../store.ts';
import type { McuState, RegisterValue } from '../sim/protocol.ts';
import type { SimulationController } from '../sim/useSimulation.ts';

const EMPTY: McuState = {
  pc: 0,
  stackPointer: 0,
  sreg: 0,
  cycles: 0,
  registers: [],
  gpr: [],
};

/**
 * Live internals of any part that reports them.
 *
 * Only parts with something to say appear, so a circuit of resistors and LEDs shows nothing here
 * rather than a list of empty rows.
 */
function PartReadouts() {
  const readouts = useStudio((s) => s.snapshot.readouts);
  const entries = Object.entries(readouts);
  if (entries.length === 0) return null;

  return (
    <>
      <Box sx={{ p: 1 }}>
        <Typography variant="overline" color="text.secondary">
          Parts
        </Typography>
        {entries.map(([partId, values]) => (
          <Box key={partId} sx={{ mt: 0.5 }}>
            <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
              {partId}
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                gap: 0.5,
                mt: 0.25,
              }}
            >
              {values.map((value) => (
                <Box
                  key={value.label}
                  sx={{
                    px: 0.75,
                    py: 0.4,
                    borderRadius: 1,
                    border: 1,
                    borderColor: value.alarm ? 'error.main' : 'divider',
                    // Alarm colouring rather than an icon: these update ten times a second and a
                    // blinking icon beside a changing number is unreadable.
                    color: value.alarm ? 'error.main' : 'text.primary',
                  }}
                >
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {value.label}
                  </Typography>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                    {value.value}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
      <Divider />
    </>
  );
}

/** SREG bits, MSB first. */
const SREG_BITS = ['I', 'T', 'H', 'S', 'V', 'N', 'Z', 'C'];

const hex = (value: number, digits = 2): string =>
  `0x${value.toString(16).toUpperCase().padStart(digits, '0')}`;

export function InspectorPanel({ sim }: { sim: SimulationController }) {
  const [state, setState] = useState<McuState>(EMPTY);
  const running = useStudio((s) => s.snapshot.running);
  const cycles = useStudio((s) => s.snapshot.cycles);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      const next = await sim.mcuState();
      if (!cancelled) setState(next);
    };

    void pull();
    // 10 Hz while running: registers change far faster than anyone can read, and polling at frame
    // rate would spend more time marshalling than the simulation spends stepping.
    if (!running) return () => {
      cancelled = true;
    };
    const timer = setInterval(() => void pull(), 100);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sim, running, cycles === 0]);

  return (
    <Box sx={{ height: '100%', overflow: 'auto' }}>
      <PartReadouts />

      <Stack direction="row" spacing={1} sx={{ p: 1, flexWrap: 'wrap' }}>
        <Tooltip title="Program counter, as a byte address — matches avr-objdump">
          <Chip size="small" variant="outlined" label={`PC ${hex(state.pc, 4)}`} />
        </Tooltip>
        <Tooltip title="Stack pointer. Falling toward your variables is how a stack overflow looks.">
          <Chip size="small" variant="outlined" label={`SP ${hex(state.stackPointer, 4)}`} />
        </Tooltip>
        <Chip size="small" variant="outlined" label={`${state.cycles.toLocaleString()} cycles`} />
      </Stack>

      <Box sx={{ px: 1, pb: 1 }}>
        <Typography variant="overline" color="text.secondary">
          SREG
        </Typography>
        <BitRow value={state.sreg} bits={SREG_BITS} />
      </Box>

      <Divider />

      <Table size="small" sx={{ '& td, & th': { py: 0.4 } }}>
        <TableHead>
          <TableRow>
            <TableCell>Register</TableCell>
            <TableCell align="right">Value</TableCell>
            <TableCell>Bits</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {state.registers.map((register) => (
            <RegisterRow key={register.name} register={register} />
          ))}
        </TableBody>
      </Table>

      {state.registers.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
          Compile and run a sketch to inspect the MCU.
        </Typography>
      )}

      <Divider />

      <Box sx={{ p: 1 }}>
        <Typography variant="overline" color="text.secondary">
          General purpose registers
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))',
            gap: 0.5,
            mt: 0.5,
          }}
        >
          {state.gpr.map((value, index) => (
            <Typography
              key={index}
              variant="caption"
              sx={{
                fontFamily: 'ui-monospace, monospace',
                color: value === 0 ? 'text.secondary' : 'text.primary',
              }}
            >
              r{index}={hex(value)}
            </Typography>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

function RegisterRow({ register }: { register: RegisterValue }) {
  return (
    <TableRow hover>
      <TableCell sx={{ fontFamily: 'ui-monospace, monospace' }}>
        <Tooltip title={`Address ${hex(register.address, 2)}`}>
          <span>{register.name}</span>
        </Tooltip>
      </TableCell>
      <TableCell align="right" sx={{ fontFamily: 'ui-monospace, monospace' }}>
        {hex(register.value)}
      </TableCell>
      <TableCell>
        <BitRow value={register.value} bits={register.bits} />
      </TableCell>
    </TableRow>
  );
}

/** Eight bits, MSB first, with set bits highlighted and named where a name exists. */
function BitRow({ value, bits }: { value: number; bits: readonly string[] }) {
  return (
    <Stack direction="row" spacing={0.25}>
      {Array.from({ length: 8 }, (_, i) => {
        const bitIndex = 7 - i;
        const set = (value & (1 << bitIndex)) !== 0;
        const name = bits[i];
        const chip = (
          <Box
            key={i}
            sx={{
              width: 16,
              textAlign: 'center',
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11,
              borderRadius: 0.5,
              bgcolor: set ? 'primary.main' : 'action.hover',
              color: set ? 'primary.contrastText' : 'text.secondary',
            }}
          >
            {set ? 1 : 0}
          </Box>
        );

        return name && name !== '-' ? (
          <Tooltip key={i} title={name}>
            {chip}
          </Tooltip>
        ) : (
          chip
        );
      })}
    </Stack>
  );
}
