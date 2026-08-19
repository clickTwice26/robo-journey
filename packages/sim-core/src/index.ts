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
