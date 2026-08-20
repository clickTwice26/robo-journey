/**
 * Fault detection.
 *
 * This is the payload of the whole project. A logic-level simulator runs a resistor-less LED
 * happily and shows it glowing; the bench gives you a dead pin. Every rule here exists because it
 * catches something that would only otherwise show up after the parts were soldered.
 */

export type FaultSeverity = 'error' | 'warning';

export interface Fault {
  /** Stable identifier, so the UI can dedupe and the tests can assert without matching prose. */
  readonly code: FaultCode;
  readonly severity: FaultSeverity;
  /** Human-readable, with the actual measured numbers in it. Vague warnings help nobody. */
  readonly message: string;
  /** Circuit element or pin the fault is attached to, for highlighting on the canvas. */
  readonly subject: string;
  /** Simulated time the fault was observed, seconds. */
  readonly time: number;
}

export type FaultCode =
  | 'pin-over-current'
  | 'supply-over-current'
  | 'led-over-current'
  | 'floating-input'
  | 'over-voltage'
  | 'i2c-no-pullup'
  | 'i2c-address-clash'
  | 'spi-no-device-selected'
  | 'spi-multiple-selected'
  | 'spi-mode-mismatch'
  | 'spi-bit-order'
  | 'spi-clock-too-fast'
  | 'spi-ss-is-input'
  | 'regulator-dropout'
  | 'regulator-over-current'
  | 'regulator-overheating'
  | 'regulator-thermal-shutdown';

/** Format a temperature. */
export function formatTemperature(celsius: number): string {
  return `${celsius.toFixed(0)} C`;
}

/** Format a power in watts or milliwatts, whichever reads better. */
export function formatPower(watts: number): string {
  if (Math.abs(watts) < 1) return `${(watts * 1000).toFixed(0)} mW`;
  return `${watts.toFixed(2)} W`;
}

export function fault(
  code: FaultCode,
  severity: FaultSeverity,
  subject: string,
  message: string,
  time: number,
): Fault {
  return { code, severity, subject, message, time };
}

/** Format an amount in amps as mA or A, whichever reads better. */
export function formatCurrent(amps: number): string {
  const abs = Math.abs(amps);
  if (abs < 1) return `${(amps * 1000).toFixed(1)} mA`;
  return `${amps.toFixed(2)} A`;
}

/** Format a voltage with a sensible number of digits. */
export function formatVoltage(volts: number): string {
  return `${volts.toFixed(2)} V`;
}
