/**
 * Physical constants and solver tolerances.
 *
 * Values follow SPICE convention where one exists, because the reference answers this project is
 * checked against (ngspice, LTspice, textbook worked examples) all assume them. Changing one
 * silently would make cross-checks disagree for reasons that look like bugs.
 */

/** Boltzmann constant, J/K (SI 2019 exact). */
export const BOLTZMANN = 1.380649e-23;

/** Elementary charge, C (SI 2019 exact). */
export const ELEMENTARY_CHARGE = 1.602176634e-19;

/** SPICE's nominal temperature: 27 degrees C. */
export const NOMINAL_TEMPERATURE_K = 300.15;

/** Thermal voltage kT/q at a given temperature. ~25.865 mV at 27 C. */
export function thermalVoltage(temperatureK = NOMINAL_TEMPERATURE_K): number {
  return (BOLTZMANN * temperatureK) / ELEMENTARY_CHARGE;
}

/** Thermal voltage at the nominal temperature, precomputed for the hot path. */
export const VT = thermalVoltage();

/**
 * Newton-Raphson convergence tolerances.
 *
 * A node is converged when its change between iterations is under `RELTOL * |v| + VNTOL`. The
 * absolute floor matters: without it, a node sitting at 0 V can never satisfy a purely relative
 * test and the loop spins forever.
 *
 * SPICE defaults to `RELTOL = 1e-3`, tuned for IC-scale netlists where iteration count dominates
 * runtime. At that setting a 5 V loop closes KVL only to about 6 mV -- larger than an ADC least
 * significant bit (4.9 mV), so a simulated multimeter would disagree with a simulated `analogRead`
 * on the same node. Our circuits are tens of nodes, not millions, so the tighter setting costs a
 * handful of extra iterations and buys residuals far below anything the UI can display.
 */
export const RELTOL = 1e-9;
/** Absolute voltage tolerance, volts. */
export const VNTOL = 1e-12;
/** Absolute current tolerance, amps. */
export const ABSTOL = 1e-12;

/** Iteration cap before the solver escalates to a homotopy fallback. */
export const MAX_NEWTON_ITERATIONS = 100;
