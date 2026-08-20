/**
 * Semantic validation for component manifests.
 *
 * The schema proves a manifest is well-formed. This proves it is *physically coherent*, which is a
 * different and much more important question when the manifest was extracted from a PDF by a
 * language model. A structurally perfect manifest can still say a pin sources 40 amps, that VIL is
 * above VIH, or that the SDA pin is one that does not exist.
 *
 * Errors block a manifest from being loaded. Warnings are surfaced next to the part so a human can
 * decide -- because a datasheet genuinely omitting an output impedance is normal, and refusing the
 * whole component over it would be worse than saying so.
 */
import type { ComponentManifest } from './manifest.js';

export type IssueSeverity = 'error' | 'warning';

export interface ValidationIssue {
  readonly severity: IssueSeverity;
  /** Dotted path into the manifest, e.g. `pins[2].model.vih`. */
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

/**
 * Largest current any single pin of a small component could plausibly carry.
 *
 * Not a datasheet number but a sanity bound: a breadboard part claiming to source 40 A has been
 * misread, most often a milliamp figure taken as amps.
 */
const IMPLAUSIBLE_PIN_AMPS = 5;
/** Above this a supply figure is almost certainly millivolts read as volts, or a typo. */
const IMPLAUSIBLE_VOLTS = 60;

export function validateManifest(manifest: ComponentManifest): ValidationResult {
  const issues: ValidationIssue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) =>
    issues.push({ severity: 'warning', path, message });

  const pinNames = new Set<string>();
  const stateNames = new Set(manifest.state.map((s) => s.name));

  // --- Pins -----------------------------------------------------------------------------------

  for (const [index, pin] of manifest.pins.entries()) {
    const at = `pins[${index}]`;
    if (pinNames.has(pin.name)) {
      error(`${at}.name`, `Duplicate pin name "${pin.name}". Terminal ids would collide.`);
    }
    pinNames.add(pin.name);
  }

  /** Check a pin reference resolves, since a dangling one would silently do nothing. */
  const requirePin = (path: string, name: string | undefined, what: string) => {
    if (name === undefined) return;
    if (!pinNames.has(name)) error(path, `${what} refers to pin "${name}", which does not exist.`);
  };

  const requireState = (path: string, name: string | undefined, what: string) => {
    if (name === undefined) return;
    if (!stateNames.has(name)) {
      error(path, `${what} refers to state "${name}", which is not declared. It would never change.`);
    }
  };

  for (const [index, pin] of manifest.pins.entries()) {
    const at = `pins[${index}].model`;
    const model = pin.model;

    switch (model.kind) {
      case 'power': {
        if (Math.abs(model.vNom) > IMPLAUSIBLE_VOLTS) {
          error(`${at}.vNom`, `${model.vNom} V is implausible for a breadboard part. Millivolts read as volts?`);
        }
        if (model.vMin !== undefined && model.vMax !== undefined && model.vMin > model.vMax) {
          error(`${at}.vMin`, `Minimum supply ${model.vMin} V exceeds maximum ${model.vMax} V.`);
        }
        if (model.vMin !== undefined && model.vNom < model.vMin) {
          warn(`${at}.vNom`, `Nominal supply ${model.vNom} V is below the stated minimum ${model.vMin} V.`);
        }
        if (model.iQuiescent > IMPLAUSIBLE_PIN_AMPS) {
          error(`${at}.iQuiescent`, `${model.iQuiescent} A quiescent is implausible. Milliamps read as amps?`);
        }
        break;
      }

      case 'digital-in': {
        if (model.vil >= model.vih) {
          // The single most consequential extraction error: it inverts every logic decision.
          error(`${at}.vil`, `VIL (${model.vil} V) must be below VIH (${model.vih} V).`);
        }
        if (model.pull !== 'none' && model.pullOhms === undefined) {
          warn(`${at}.pullOhms`, `A ${model.pull} pull is declared with no resistance; a default will be assumed.`);
        }
        break;
      }

      case 'digital-out': {
        if (model.sourceMaxA > IMPLAUSIBLE_PIN_AMPS || model.sinkMaxA > IMPLAUSIBLE_PIN_AMPS) {
          error(`${at}.sourceMaxA`, `Drive current above ${IMPLAUSIBLE_PIN_AMPS} A is implausible for a pin.`);
        }
        if (model.openDrain && model.sourceMaxA > 0) {
          warn(`${at}.sourceMaxA`, `Open-drain outputs cannot source current; sourceMaxA is ignored.`);
        }
        break;
      }

      case 'passive': {
        requirePin(`${at}.toPin`, model.toPin, 'Passive');
        if (model.toPin === pin.name) {
          error(`${at}.toPin`, `Passive on "${pin.name}" connects to itself.`);
        }
        if (model.ohms === undefined && model.farads === undefined) {
          error(at, `Passive on "${pin.name}" specifies neither a resistance nor a capacitance.`);
        }
        break;
      }

      case 'led': {
        requirePin(`${at}.cathodePin`, model.cathodePin, 'LED');
        if (model.ifNominalA > model.ifMaxA) {
          error(`${at}.ifNominalA`, `Nominal current exceeds the absolute maximum.`);
        }
        if (model.vf <= 0 || model.vf > 12) {
          error(`${at}.vf`, `Forward voltage ${model.vf} V is outside anything a real LED does.`);
        }
        break;
      }

      default:
        break;
    }
  }

  // --- Supply pins ------------------------------------------------------------------------------

  const hasPower = manifest.pins.some((p) => p.model.kind === 'power');
  const hasGround = manifest.pins.some((p) => p.model.kind === 'ground');
  // Transistors and passives are three-terminal or two-terminal devices wired into someone else's
  // circuit; they have no supply pin of their own and demanding one would reject every one of them.
  const isActive = !['passive', 'variable-resistor', 'transistor'].includes(manifest.behavior.kind);

  if (isActive && !hasPower) {
    error('pins', 'An active component has no power pin, so it can never be energised.');
  }
  if (isActive && !hasGround) {
    error('pins', 'An active component has no ground pin, so no current can return.');
  }

  // --- State variables --------------------------------------------------------------------------

  for (const [index, variable] of manifest.state.entries()) {
    const at = `state[${index}]`;
    if (variable.min >= variable.max) {
      error(`${at}.min`, `Range is empty: min ${variable.min} is not below max ${variable.max}.`);
    }
    if (variable.default < variable.min || variable.default > variable.max) {
      error(`${at}.default`, `Default ${variable.default} is outside the range ${variable.min}..${variable.max}.`);
    }
  }

  // --- Behaviour ---------------------------------------------------------------------------------

  const behavior = manifest.behavior;
  switch (behavior.kind) {
    case 'analog-sensor': {
      requirePin('behavior.outputPin', behavior.outputPin, 'Analog sensor');
      requireState('behavior.state', behavior.state, 'Analog sensor');
      if (behavior.voltsPerUnit === 0) {
        warn('behavior.voltsPerUnit', 'Transfer function is zero; the output will never change.');
      }
      break;
    }

    case 'variable-resistor': {
      requirePin('behavior.pinA', behavior.pinA, 'Variable resistor');
      requirePin('behavior.pinB', behavior.pinB, 'Variable resistor');
      requireState('behavior.state', behavior.state, 'Variable resistor');
      if (behavior.pinA === behavior.pinB) {
        error('behavior.pinB', 'Both terminals are the same pin.');
      }
      break;
    }

    case 'i2c-peripheral': {
      requirePin('behavior.sdaPin', behavior.sdaPin, 'I2C peripheral');
      requirePin('behavior.sclPin', behavior.sclPin, 'I2C peripheral');
      // The I2C spec reserves the lowest and highest eight addresses.
      if (behavior.address <= 0x07 || behavior.address >= 0x78) {
        error('behavior.address', `0x${behavior.address.toString(16)} is a reserved I2C address.`);
      }
      for (const [index, register] of behavior.registers.entries()) {
        requireState(`behavior.registers[${index}].fromState`, register.fromState, 'Register');
      }
      break;
    }

    case 'spi-peripheral': {
      for (const key of ['mosiPin', 'misoPin', 'sckPin', 'csPin'] as const) {
        requirePin(`behavior.${key}`, behavior[key], 'SPI peripheral');
      }
      for (const [index, register] of behavior.registers.entries()) {
        requireState(`behavior.registers[${index}].fromState`, register.fromState, 'Register');
      }
      break;
    }

    case 'pulse-echo': {
      requirePin('behavior.triggerPin', behavior.triggerPin, 'Rangefinder');
      requirePin('behavior.echoPin', behavior.echoPin, 'Rangefinder');
      requireState('behavior.state', behavior.state, 'Rangefinder');
      if (behavior.triggerPin === behavior.echoPin) {
        warn('behavior.echoPin', 'Trigger and echo share a pin; only some modules work this way.');
      }
      const variable = manifest.state.find((s) => s.name === behavior.state);
      if (variable && behavior.secondsPerUnit * variable.max > behavior.timeoutSeconds) {
        warn(
          'behavior.timeoutSeconds',
          `At the maximum ${behavior.state} the echo would exceed the timeout, so the top of the range is unreachable.`,
        );
      }
      break;
    }

    case 'pwm-actuator': {
      requirePin('behavior.signalPin', behavior.signalPin, 'Actuator');
      if (behavior.minPulseSeconds >= behavior.maxPulseSeconds) {
        error('behavior.minPulseSeconds', 'Minimum pulse width is not below the maximum.');
      }
      if (behavior.maxPulseSeconds > 0.02) {
        warn('behavior.maxPulseSeconds', 'A pulse longer than the usual 20 ms frame will not fit.');
      }
      if (behavior.holdCurrentA > behavior.movingCurrentA) {
        warn('behavior.holdCurrentA', 'Holding current exceeds moving current, which is unusual.');
      }
      break;
    }

    case 'transistor': {
      for (const key of ['collectorPin', 'basePin', 'emitterPin'] as const) {
        requirePin(`behavior.${key}`, behavior[key], 'Transistor');
      }
      const terminals = new Set([behavior.collectorPin, behavior.basePin, behavior.emitterPin]);
      if (terminals.size !== 3) {
        error('behavior', 'Collector, base and emitter must be three different pins.');
      }
      if (behavior.forwardBeta < 1) {
        error('behavior.forwardBeta', `hFE of ${behavior.forwardBeta} would attenuate, not amplify.`);
      }
      if (behavior.forwardBeta > 100_000) {
        warn('behavior.forwardBeta', `hFE of ${behavior.forwardBeta} is implausible outside a Darlington.`);
      }
      if (behavior.saturationCurrent > 1e-6) {
        // A transport Is that large makes the device conduct at almost no bias at all.
        error('behavior.saturationCurrent', `${behavior.saturationCurrent} A is far too large; small-signal parts are around 1e-14.`);
      }
      break;
    }

    case 'threshold-switch': {
      requirePin('behavior.outputPin', behavior.outputPin, 'Threshold switch');
      requireState('behavior.state', behavior.state, 'Threshold switch');
      const variable = manifest.state.find((s) => s.name === behavior.state);
      if (variable && (behavior.threshold < variable.min || behavior.threshold > variable.max)) {
        warn(
          'behavior.threshold',
          `Threshold ${behavior.threshold} lies outside the range of ${behavior.state}, so it never trips.`,
        );
      }
      break;
    }

    default:
      break;
  }

  // --- Package ------------------------------------------------------------------------------------

  const maxX = Math.max(...manifest.pins.map((p) => p.x));
  const maxY = Math.max(...manifest.pins.map((p) => p.y));
  if (maxX > manifest.package.widthMm || maxY > manifest.package.heightMm) {
    warn('package', 'Some pins lie outside the package outline; the artwork will look wrong.');
  }
  if (manifest.pins.some((p) => p.x < 0 || p.y < 0)) {
    warn('pins', 'Some pins have negative coordinates, placing them above or left of the body.');
  }

  // --- Limits --------------------------------------------------------------------------------------

  const { limits } = manifest;
  if (limits.vccMinVolts !== undefined && limits.vccMaxVolts !== undefined && limits.vccMinVolts > limits.vccMaxVolts) {
    error('limits', `Minimum supply exceeds maximum.`);
  }
  if (limits.pinMaxAmps !== undefined && limits.pinMaxAmps > IMPLAUSIBLE_PIN_AMPS) {
    error('limits.pinMaxAmps', `${limits.pinMaxAmps} A per pin is implausible. Milliamps read as amps?`);
  }
  if (limits.vccMaxVolts === undefined) {
    warn('limits.vccMaxVolts', 'No absolute maximum supply voltage, so over-voltage cannot be detected.');
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/** Format issues for a log or a CLI. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `${i.severity === 'error' ? 'ERROR' : 'warn '} ${i.path}: ${i.message}`).join('\n');
}
