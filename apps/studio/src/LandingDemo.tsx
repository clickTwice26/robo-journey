/**
 * The hero demo: a fire alarm, running itself.
 *
 * A cursor drags a flame towards a sensor, the sensor's reading climbs as it enters the cone, and
 * past the threshold the sketch drives the buzzer. Then it takes the flame away and everything
 * goes back. It is the whole product in eight seconds, and it needs no explanation because you can
 * see the cause and the effect in the same frame.
 *
 * ## The numbers are the real ones
 *
 * The reading comes from `contributionAt` in the environment module -- the function the simulator
 * itself uses to work out what a flame at some distance amounts to. A hand-tuned curve that merely
 * looked convincing would be a landing page lying about the one thing the product claims to do
 * well, on the page making the claim.
 *
 * ## It does not make a noise
 *
 * The buzzer is shown sounding and stays silent. A page that starts playing a tone at somebody who
 * has just opened it has misjudged the room, and browsers block it anyway.
 */
import { useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { contributionAt, type EnvironmentSource } from '@robo-journey/parts';

/** One full pass: approach, linger, retreat, pause. Seconds. */
const CYCLE_SECONDS = 8;

/** Where things sit in the little scene, in viewBox units. */
const SENSOR = { x: 250, y: 232 };
const BUZZER = { x: 372, y: 250 };
/** The flame's path: in from the left, up to the sensor's face, and back. */
const FAR = { x: 66, y: 300 };
const NEAR = { x: 176, y: 240 };

/** Above this the sketch sounds the alarm, matching the library project's own threshold. */
const ALARM_AT = 0.36;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * How far along the approach the flame is, 0 to 1, and whether the cursor is holding it.
 *
 * Shaped rather than linear: it moves in, waits where a person would wait to see what happens, and
 * leaves. A constant-speed slide back and forth reads as a screensaver.
 */
function phaseOf(t: number): { closeness: number; holding: boolean } {
  if (t < 0.06) return { closeness: 0, holding: false };
  if (t < 0.38) return { closeness: (t - 0.06) / 0.32, holding: true };
  if (t < 0.68) return { closeness: 1, holding: true };
  if (t < 0.92) return { closeness: 1 - (t - 0.68) / 0.24, holding: true };
  return { closeness: 0, holding: false };
}

export function LandingDemo() {
  const theme = useTheme();
  const dark = theme.palette.mode === 'dark';
  const [t, setT] = useState(0);

  // Somebody who has asked their system not to animate things should not be handed a looping
  // animation. They get the moment it is all about instead: the flame in close, the alarm going.
  const still =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const raf = useRef(0);
  useEffect(() => {
    if (still) {
      setT(0.5);
      return;
    }
    const started = performance.now();
    const loop = (now: number) => {
      setT((((now - started) / 1000) % CYCLE_SECONDS) / CYCLE_SECONDS);
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [still]);

  const { closeness, holding } = phaseOf(t);
  const flame = { x: lerp(FAR.x, NEAR.x, closeness), y: lerp(FAR.y, NEAR.y, closeness) };

  // The simulator's own arithmetic, on the scene's own geometry.
  const source: EnvironmentSource = {
    id: 'demo-flame',
    quantity: 'flame',
    x: flame.x,
    y: flame.y,
    intensity: 1,
    reachMm: 62,
    active: true,
  };
  const reading = contributionAt(source, SENSOR.x, SENSOR.y);
  const alarming = reading > ALARM_AT;
  // What analogRead would hand the sketch, on the flame sensor's real transfer function.
  const adc = Math.round(Math.min(1023, ((reading * 4.5 + 0.2) / 5) * 1023));

  const flicker = Math.sin(t * CYCLE_SECONDS * 11) * 0.05 + Math.sin(t * CYCLE_SECONDS * 17) * 0.03;
  const ring = Math.floor(t * CYCLE_SECONDS * 8) % 3;

  const canvasBg = dark ? '#0f1115' : '#e7eaef';
  const gridDot = dark ? '#1c2027' : '#cfd5de';
  const ink = dark ? '#e6e9ef' : '#1a1d23';
  const muted = dark ? '#9aa4b2' : '#5a6371';
  const panel = dark ? '#14161a' : '#e4e7ed';

  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1.5,
        overflow: 'hidden',
        bgcolor: 'background.paper',
      }}
    >
      <Box component="svg" viewBox="0 0 640 400" sx={{ width: '100%', display: 'block' }}>
        {/* Chrome, so it is recognisably the app rather than a diagram of one. */}
        <rect x={0} y={0} width={640} height={30} fill={panel} />
        <text x={14} y={19} fill={ink} fontSize={10} fontWeight={700} fontFamily="system-ui">
          robo-journey
        </text>
        <rect x={92} y={7} width={54} height={17} rx={3} fill={dark ? '#1f242c' : '#d5dae2'} />
        <text x={104} y={19} fill={muted} fontSize={9} fontFamily="system-ui">
          Compile
        </text>
        <rect x={152} y={7} width={68} height={17} rx={3} fill="#1565c0" />
        <text x={162} y={19} fill="#fff" fontSize={9} fontWeight={600} fontFamily="system-ui">
          ▶ Running
        </text>
        <text x={556} y={19} fill={muted} fontSize={9} fontFamily="ui-monospace, monospace">
          {(t * CYCLE_SECONDS).toFixed(2)} s
        </text>
        <line x1={0} y1={30} x2={640} y2={30} stroke={theme.palette.divider} />

        {/* Canvas */}
        <rect x={0} y={30} width={640} height={296} fill={canvasBg} />
        {Array.from({ length: 22 }, (_, i) =>
          Array.from({ length: 11 }, (_, j) => (
            <circle key={`${i}-${j}`} cx={14 + i * 30} cy={44 + j * 27} r={1} fill={gridDot} />
          )),
        )}

        {/* The board */}
        <rect x={392} y={52} width={222} height={104} rx={5} fill="#0f7b8a" />
        <rect x={412} y={58} width={92} height={9} rx={1.5} fill="#15181d" />
        <rect x={512} y={58} width={82} height={9} rx={1.5} fill="#15181d" />
        <rect x={412} y={141} width={92} height={9} rx={1.5} fill="#15181d" />
        <rect x={512} y={141} width={82} height={9} rx={1.5} fill="#15181d" />
        <rect x={462} y={88} width={92} height={30} rx={2} fill="#15181d" />
        <text x={470} y={107} fill="#5f7f86" fontSize={8} fontFamily="ui-monospace, monospace">
          ATmega328P
        </text>

        {/* Wires: sensor and buzzer back to the header. */}
        <path d={`M ${SENSOR.x} ${SENSOR.y - 18} C 330 190 380 180 430 150`} stroke="#d84a4a" strokeWidth={1.8} fill="none" />
        <path d={`M ${SENSOR.x + 10} ${SENSOR.y - 18} C 340 200 400 190 452 150`} stroke="#2c3e50" strokeWidth={1.8} fill="none" />
        <path d={`M ${BUZZER.x} ${BUZZER.y - 16} C 400 200 460 180 500 152`} stroke="#f5a524" strokeWidth={1.8} fill="none" />

        {/* What the sensor can see. The wedge is its real 60 degrees, aimed at the flame's path. */}
        <path
          d={`M ${SENSOR.x} ${SENSOR.y} L ${SENSOR.x - 150} ${SENSOR.y - 87} A 173 173 0 0 0 ${SENSOR.x - 150} ${SENSOR.y + 87} Z`}
          fill="#e8590c"
          opacity={alarming ? 0.12 : 0.06}
        />
        <path
          d={`M ${SENSOR.x} ${SENSOR.y} L ${SENSOR.x - 150} ${SENSOR.y - 87} A 173 173 0 0 0 ${SENSOR.x - 150} ${SENSOR.y + 87} Z`}
          fill="none"
          stroke="#e8590c"
          strokeWidth={1}
          strokeDasharray="4 5"
          opacity={0.45}
        />

        {/* Flame sensor */}
        <rect x={SENSOR.x - 16} y={SENSOR.y - 18} width={32} height={36} rx={3} fill="#3d1f1f" stroke="#5a2f2f" />
        <text x={SENSOR.x} y={SENSOR.y + 2} fill="#c99" fontSize={7} textAnchor="middle" fontFamily="ui-monospace, monospace">
          KY-026
        </text>
        <circle cx={SENSOR.x} cy={SENSOR.y} r={22} fill="none" stroke="#e8590c" strokeWidth={1.2} opacity={0.6} />
        <text x={SENSOR.x} y={SENSOR.y - 28} fill="#e8590c" fontSize={9} fontWeight={700} textAnchor="middle" fontFamily="ui-monospace, monospace">
          {reading.toFixed(2)}
        </text>

        {/* Buzzer, with pressure arcs while it is sounding. */}
        <circle cx={BUZZER.x} cy={BUZZER.y} r={15} fill="#101216" stroke="#2b3038" />
        <circle cx={BUZZER.x} cy={BUZZER.y} r={5} fill={alarming ? '#7ec8ff' : '#2b3038'} />
        {alarming &&
          [0, 1, 2].map((i) => (
            <path
              key={i}
              d={`M ${BUZZER.x + 18 + i * 7} ${BUZZER.y - 9 - i * 4} Q ${BUZZER.x + 25 + i * 7} ${BUZZER.y} ${BUZZER.x + 18 + i * 7} ${BUZZER.y + 9 + i * 4}`}
              stroke="#7ec8ff"
              strokeWidth={1.8}
              fill="none"
              opacity={i === ring ? 0.95 : 0.3}
            />
          ))}

        {/* The flame, carried. */}
        <g transform={`translate(${flame.x} ${flame.y}) scale(${1 + flicker} ${1 - flicker})`}>
          <path d="M 0 0 C -12 -7 -9 -19 0 -29 C 9 -19 12 -7 0 0 Z" fill="#ff7a3d" opacity={0.92} />
          <path d="M 0 -2 C -6 -7 -4 -14 0 -20 C 4 -14 6 -7 0 -2 Z" fill="#ffd257" />
        </g>

        {/* The cursor doing the carrying. */}
        <g transform={`translate(${flame.x + 7} ${flame.y + 4})`} opacity={holding ? 1 : 0.55}>
          <path d="M 0 0 L 0 15 L 4 11.5 L 7 17 L 9.5 15.5 L 6.5 10.5 L 11 10 Z" fill={ink} stroke={dark ? '#000' : '#fff'} strokeWidth={0.8} />
        </g>

        {/* Bottom strip: what the sketch is printing, and the alarm when it fires. */}
        <line x1={0} y1={326} x2={640} y2={326} stroke={theme.palette.divider} />
        <rect x={0} y={326} width={640} height={74} fill={panel} />
        <text x={14} y={345} fill={muted} fontSize={9} fontWeight={600} fontFamily="system-ui">
          Serial Monitor
        </text>
        <text x={14} y={364} fill={ink} fontSize={10} fontFamily="ui-monospace, monospace">
          ir={adc}
        </text>
        <text x={14} y={382} fill={alarming ? '#e8590c' : muted} fontSize={10} fontFamily="ui-monospace, monospace">
          {alarming ? 'ALARM  buzzer on D8 HIGH' : 'clear'}
        </text>

        {alarming && (
          <>
            <rect x={470} y={340} width={154} height={22} rx={11} fill="#e8590c" opacity={0.14} />
            <circle cx={486} cy={351} r={4} fill="#e8590c" opacity={ring === 0 ? 1 : 0.4} />
            <text x={498} y={355} fill="#e8590c" fontSize={10} fontWeight={700} fontFamily="system-ui">
              Buzzer sounding
            </text>
          </>
        )}
      </Box>
    </Box>
  );
}
