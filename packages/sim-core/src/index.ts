/**
 * @robo-journey/sim-core
 *
 * The simulation engine. Deliberately free of DOM and framework dependencies so it runs headless
 * under Vitest, inside a Web Worker, and later inside a Tauri desktop shell without change.
 */
export { Atmega328p, UNO_CLOCK_HZ } from './mcu/atmega328p.js';
export type {
  Atmega328pOptions,
  PinChange,
  PinChangeListener,
  PinDriveState,
  SerialListener,
} from './mcu/atmega328p.js';

export {
  ATMEGA328P_FLASH_BYTES,
  HexParseError,
  flashToProgMem,
  loadHex,
  parseIntelHex,
} from './mcu/hex.js';

export { LED_BUILTIN, UNO_PINS, pinByLabel, pinByPort } from './mcu/pin-map.js';
export type { PinLocation, PortId } from './mcu/pin-map.js';

// --- Analog engine -----------------------------------------------------------------------------

export { Circuit, ConvergenceError } from './analog/circuit.js';
export type { SolveResult } from './analog/circuit.js';

export { GMIN, GROUND, MnaSystem } from './analog/mna.js';
export { DenseSolver, SingularMatrixError } from './analog/lu.js';

export {
  ABSTOL,
  MAX_NEWTON_ITERATIONS,
  NOMINAL_TEMPERATURE_K,
  RELTOL,
  VNTOL,
  VT,
  thermalVoltage,
} from './analog/constants.js';

export {
  Capacitor,
  CurrentSource,
  DIODE_1N4148,
  Diode,
  Inductor,
  Led,
  Resistor,
  Switch,
  VoltageSource,
  ledModel,
} from './analog/devices.js';
export type {
  Device,
  DiodeModel,
  IntegrationMethod,
  LedColor,
  StampContext,
} from './analog/devices.js';

// --- MCU / circuit coupling --------------------------------------------------------------------

export { Board } from './sched/board.js';
export type { BoardOptions } from './sched/board.js';

export {
  AvrPin,
  INPUT_IMPEDANCE_OHMS,
  OUTPUT_IMPEDANCE_OHMS,
  PIN_ABSOLUTE_MAX_CURRENT,
  PULLUP_OHMS,
  SUPPLY_ABSOLUTE_MAX_CURRENT,
  VIH_FACTOR,
  VIL_FACTOR,
} from './mcu/pin-model.js';
export type { LogicLevel } from './mcu/pin-model.js';

export { fault, formatCurrent, formatVoltage } from './faults/index.js';
export type { Fault, FaultCode, FaultSeverity } from './faults/index.js';

// --- Netlist and breadboard topology ------------------------------------------------------------

export { Netlist } from './netlist/netlist.js';
export {
  ALL_ROWS,
  FULL_SIZE_BREADBOARD,
  HALF_SIZE_BREADBOARD,
  MINI_BREADBOARD,
  LOWER_ROWS,
  UPPER_ROWS,
  addBreadboard,
  boardRows,
  breadboardHoles,
  channelBounds,
  holeId,
  railHoleId,
  railOffset,
  railSegmentOf,
  rowOffset,
} from './netlist/breadboard.js';
export type {
  BreadboardRow,
  BreadboardSpec,
  RailPolarity,
  RailSide,
} from './netlist/breadboard.js';

// --- Instruments --------------------------------------------------------------------------------

export { SignalRecorder } from './instruments/recorder.js';
export type {
  ChannelKind,
  ChannelSpec,
  ChannelWindow,
  Edge,
  RecorderOptions,
} from './instruments/recorder.js';

export { decodeUart, framesToText, levelAt } from './instruments/decode.js';
export type { UartFrame, UartOptions } from './instruments/decode.js';

export {
  SUPPLY_CURRENT_CHANNEL,
  analogChannel,
  digitalChannel,
} from './sched/board.js';

export { UsartTxLine } from './mcu/usart-tx.js';

// --- Debugger -----------------------------------------------------------------------------------

export { decode, disassemble, indexByAddress } from './debug/disassemble.js';
export type { DisasmLine, DisassembleOptions } from './debug/disassemble.js';
export { DATA_SPACE, IO_SPACE, dataName, ioName } from './debug/io-registers.js';
