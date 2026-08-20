/**
 * Instruments: meters and scopes you place on the canvas and wire up like anything else.
 *
 * Deliberately not a panel bolted to the Arduino's header. A panel can only ever show you what the
 * board's own pins are doing, and most of what goes wrong in a circuit happens between them -- at
 * the junction of a divider, across a shunt, on the far side of a transistor. These are parts:
 * they have terminals, you run wires from those terminals to any point in the circuit, and the
 * measurement is taken there.
 *
 * Being real parts also means they are real loads. That is the whole reason to do it this way. A
 * voltmeter is ten megohms and an ammeter is a resistor in series, so the act of measuring changes
 * the circuit by exactly as much as it does on the bench -- which is nothing at all, right up
 * until the moment it is everything.
 *
 * Sizes are compact rather than literal. A bench multimeter is nearly three times the size of an
 * Arduino Uno and a scope is bigger than the desk it sits on; drawn to scale on the canvas they
 * would bury the circuit they are measuring.
 */
import { Ammeter, Multimeter, ScopeChannel, type ChannelSpec } from '@robo-journey/sim-core';
import type { PartDefinition } from './registry.js';

/** Scope channel names, in order. Also the order they are drawn and coloured. */
export const SCOPE_CHANNELS = ['CH1', 'CH2', 'CH3', 'CH4'] as const;

/**
 * Recorder channel id for one instrument probe.
 *
 * The part id is inside the channel id on purpose: the UI reads the recorder's channel list to
 * find out which scopes are in the circuit, so no separate registry has to be kept in step.
 */
export const probeChannel = (partId: string, pin: string): string => `probe:${partId}:${pin}`;

/** Split a probe channel id back into the part and pin it came from. */
export function parseProbeChannel(id: string): { partId: string; pin: string } | null {
  const parts = id.split(':');
  if (parts.length !== 3 || parts[0] !== 'probe') return null;
  return { partId: parts[1]!, pin: parts[2]! };
}

/**
 * Digital multimeter.
 *
 * Three jacks, as the real thing has, because which jack the lead is in is half of what there is
 * to get wrong. The current jack is live whatever the dial says.
 */
const MULTIMETER: PartDefinition = {
  type: 'multimeter',
  label: 'Multimeter',
  category: 'instrument',
  width: 62,
  height: 44,
  pins: [
    { name: 'V', x: 14, y: 40, label: 'V / ohms probe (red)' },
    { name: 'COM', x: 31, y: 40, label: 'COM probe (black)' },
    { name: 'A', x: 48, y: 40, label: 'Current probe (red)' },
  ],
  defaults: { mode: 'volts', range: 'mA', fuseBlown: false },
  // Only the dial and the range change the circuit; nothing here is display-only.
  build(ctx) {
    const mode = String(ctx.props.mode ?? 'volts') as 'volts' | 'amps' | 'ohms';
    const range = String(ctx.props.range ?? 'mA') as 'mA' | 'A';
    const meter = new Multimeter(
      ctx.partId,
      ctx.node('V'),
      ctx.node('COM'),
      ctx.node('A'),
      { mode, range, blown: ctx.props.fuseBlown === true },
    );
    ctx.add(meter);
  },
};

/**
 * In-line ammeter.
 *
 * Two terminals, so there is no way to use it without breaking the circuit open -- which is the
 * correct instinct and the one a clip-across current meter would destroy. Clip this across
 * anything low-impedance and the fuse goes, as it would on the bench.
 */
const AMMETER: PartDefinition = {
  type: 'ammeter',
  label: 'Ammeter',
  category: 'instrument',
  width: 34,
  height: 22,
  pins: [
    { name: 'in', x: 8, y: 18, label: 'In (+)' },
    { name: 'out', x: 26, y: 18, label: 'Out (-)' },
  ],
  defaults: { range: 'mA', fuseBlown: false },
  build(ctx) {
    const range = String(ctx.props.range ?? 'mA') as 'mA' | 'A';
    ctx.add(
      new Ammeter(ctx.partId, ctx.node('in'), ctx.node('out'), {
        range,
        blown: ctx.props.fuseBlown === true,
      }),
    );
  },
};

/**
 * Four-channel oscilloscope.
 *
 * Each channel is a megohm to the scope's own ground terminal rather than to circuit ground, which
 * is why the ground clip is a real wire you have to run. Leave it off and the traces float, exactly
 * as an unclipped probe does.
 *
 * The timebase and vertical scale are display properties: changing them redraws the screen and
 * does not disturb the circuit or the capture.
 */
const OSCILLOSCOPE: PartDefinition = {
  type: 'oscilloscope',
  label: 'Oscilloscope',
  category: 'instrument',
  width: 112,
  height: 68,
  pins: [
    { name: 'CH1', x: 16, y: 63, label: 'Channel 1 probe' },
    { name: 'CH2', x: 32, y: 63, label: 'Channel 2 probe' },
    { name: 'CH3', x: 48, y: 63, label: 'Channel 3 probe' },
    { name: 'CH4', x: 64, y: 63, label: 'Channel 4 probe' },
    { name: 'GND', x: 92, y: 63, label: 'Ground clip' },
  ],
  // Centred on 2.5 V at a volt per division, so a 0 to 5 V logic signal lands inside the
  // graticule the moment a probe touches it. A bench scope would start at zero offset and show a
  // trace pinned to the top of the screen, which is a worse first thing to see than a useful one.
  defaults: { span: 0.05, voltsPerDiv: 1, offsetVolts: 2.5 },
  displayProps: ['span', 'voltsPerDiv', 'offsetVolts'],
  build(ctx) {
    const ground = ctx.node('GND');
    for (const name of SCOPE_CHANNELS) {
      const channel = new ScopeChannel(`${ctx.partId}:${name}`, ctx.node(name), ground);
      ctx.add(channel);

      // Without a recorder there is still a working probe -- it just has nowhere to draw. That is
      // the case in headless tests, and it should not be an error.
      const spec: ChannelSpec = {
        id: probeChannel(ctx.partId, name),
        kind: 'analog',
        label: `${ctx.partId} ${name}`,
      };
      ctx.watchProbe?.(spec, () => channel.volts);
    }
  },
};

export const INSTRUMENTS: readonly PartDefinition[] = [MULTIMETER, AMMETER, OSCILLOSCOPE];
