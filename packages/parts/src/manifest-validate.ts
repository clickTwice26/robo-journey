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
 * Currents above which something is almost certainly wrong.
 *
 * There is no single threshold that separates a unit error from a real power device: a 20 mA pin
 * misread as 20 A and an IRLZ44N's genuine 47 A occupy the same range. So there are two bounds.
 *
 * Above `SUSPICIOUS` is worth flagging, because for the small parts most circuits use it usually
 * is a milliamp figure taken as amps. Above `IMPLAUSIBLE` nothing that fits in a breadboard can
 * carry it, and that is an error.
 *
 * The first version of this had one bound at 5 A, and it rejected a correctly extracted power
 * MOSFET three times running -- refusing accurate data is worse than accepting suspicious data
 * with a warning attached.
 */
const SUSPICIOUS_PIN_AMPS = 5;
const IMPLAUSIBLE_PIN_AMPS = 200;
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
          error(`${at}.iQuiescent`, `${model.iQuiescent} A quiescent is implausible.`);
        } else if (model.iQuiescent > SUSPICIOUS_PIN_AMPS) {
          warn(`${at}.iQuiescent`, `${model.iQuiescent} A of quiescent draw is very high. Milliamps read as amps?`);
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
        const drive = Math.max(model.sourceMaxA, model.sinkMaxA);
        if (drive > IMPLAUSIBLE_PIN_AMPS) {
          error(`${at}.sourceMaxA`, `Drive current above ${IMPLAUSIBLE_PIN_AMPS} A is implausible for a pin.`);
        } else if (drive > SUSPICIOUS_PIN_AMPS) {
          warn(`${at}.sourceMaxA`, `${drive} A of drive is very high for a logic output. Milliamps read as amps?`);
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
  // Discrete two- and three-terminal devices are wired into someone else's circuit and have no
  // supply pin of their own; demanding one would reject every transistor, MOSFET and pot.
  const isActive = !['passive', 'variable-resistor', 'transistor', 'mosfet', 'potentiometer', 'diode', 'capacitor']
    .includes(manifest.behavior.kind);

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
      // Four distinct wires. Extraction sometimes maps two roles onto one pin when a datasheet's
      // table lists a shared-function pin twice, and the result routes bytes nowhere.
      const spiPins = [behavior.mosiPin, behavior.misoPin, behavior.sckPin, behavior.csPin];
      if (new Set(spiPins).size !== spiPins.length) {
        error('behavior.csPin', 'MOSI, MISO, SCK and CS must be four different pins.');
      }
      for (const [index, register] of behavior.registers.entries()) {
        requireState(`behavior.registers[${index}].fromState`, register.fromState, 'Register');
      }
      if (behavior.addressing === 'register' && behavior.registers.length === 0) {
        warn(
          'behavior.registers',
          'Register addressing with no registers declared: every read will return zero. Use ' +
            '"stream" addressing for a part that has no register map.',
        );
      }
      // An ATmega328P can clock SPI at 8 MHz at most, so a lower ceiling than that is a real
      // constraint on the sketch; anything above it can never be hit and is likely a unit slip.
      if (behavior.maxClockHz !== undefined && behavior.maxClockHz < 1e5) {
        warn(
          'behavior.maxClockHz',
          `${behavior.maxClockHz} Hz is very slow for SPI. Kilohertz read as hertz?`,
        );
      }
      break;
    }

    case 'regulator': {
      requirePin('behavior.inputPin', behavior.inputPin, 'Regulator');
      requirePin('behavior.outputPin', behavior.outputPin, 'Regulator');
      requirePin('behavior.groundPin', behavior.groundPin, 'Regulator');

      const regPins = [behavior.inputPin, behavior.outputPin, behavior.groundPin];
      if (new Set(regPins).size !== regPins.length) {
        error('behavior.outputPin', 'Input, output and ground must be three different pins.');
      }

      if (behavior.outputVolts <= 0) {
        error('behavior.outputVolts', 'A regulator with a zero or negative output regulates nothing.');
      }
      // The check that matters most: a manifest claiming a part regulates on less headroom than it
      // has would make an under-powered circuit look fine, which is the exact failure the archetype
      // exists to catch.
      if (behavior.dropoutVolts <= 0) {
        error(
          'behavior.dropoutVolts',
          'Zero dropout is not a real part. Even the best LDOs need 100-200 mV; a 78xx needs 2 V.',
        );
      } else if (behavior.dropoutVolts > 5) {
        warn(
          'behavior.dropoutVolts',
          `${behavior.dropoutVolts} V of dropout is unusually high. Check this is the headroom the ` +
            `part needs and not its maximum input voltage.`,
        );
      }

      if (behavior.quiescentAmps > behavior.maxOutputAmps) {
        error(
          'behavior.quiescentAmps',
          'The part consumes more than it can deliver, which cannot be right.',
        );
      }
      if (behavior.quiescentAmps > 0.1) {
        warn(
          'behavior.quiescentAmps',
          `${behavior.quiescentAmps} A of quiescent draw is very high. Milliamps read as amps?`,
        );
      }

      // Thermal resistance decides whether the part survives its own dissipation, so a wrong
      // figure here silently removes the overheating warning entirely.
      if (behavior.thermalOhmsPerWatt < 1) {
        warn(
          'behavior.thermalOhmsPerWatt',
          `${behavior.thermalOhmsPerWatt} K/W is lower than a large heatsink achieves. With a ` +
            `figure this low the part will never be reported as overheating.`,
        );
      } else if (behavior.thermalOhmsPerWatt > 500) {
        warn(
          'behavior.thermalOhmsPerWatt',
          `${behavior.thermalOhmsPerWatt} K/W is higher than any packaged regulator. This is the ` +
            `junction-to-ambient figure, not junction-to-case.`,
        );
      }

      if (behavior.thermalShutdownC < 80 || behavior.thermalShutdownC > 200) {
        warn(
          'behavior.thermalShutdownC',
          `Thermal shutdown at ${behavior.thermalShutdownC} C is outside the 125-175 C range ` +
            `regulators use.`,
        );
      }

      const limitVMax = manifest.limits.vccMaxVolts;
      if (limitVMax !== undefined && limitVMax < behavior.outputVolts + behavior.dropoutVolts) {
        error(
          'limits.vccMaxVolts',
          `The maximum input of ${limitVMax} V is below the ` +
            `${behavior.outputVolts + behavior.dropoutVolts} V this part needs to regulate at all.`,
        );
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

    case 'mosfet': {
      for (const key of ['drainPin', 'gatePin', 'sourcePin'] as const) {
        requirePin(`behavior.${key}`, behavior[key], 'MOSFET');
      }
      if (new Set([behavior.drainPin, behavior.gatePin, behavior.sourcePin]).size !== 3) {
        error('behavior', 'Drain, gate and source must be three different pins.');
      }
      if (behavior.thresholdVolts <= 0 || behavior.thresholdVolts > 20) {
        error('behavior.thresholdVolts', `A gate threshold of ${behavior.thresholdVolts} V is outside anything real.`);
      }
      if (behavior.rdsOnOhms > 100) {
        warn('behavior.rdsOnOhms', `${behavior.rdsOnOhms} ohm on-resistance is very high; ohms read as milliohms?`);
      }
      // Worth saying out loud, because it is the commonest MOSFET mistake in Arduino projects.
      if (behavior.channel === 'n' && behavior.thresholdVolts > 2.5) {
        warn(
          'behavior.thresholdVolts',
          `A ${behavior.thresholdVolts} V threshold means this is not a logic-level device: a 5 V ` +
            `gate will not turn it fully on, and it will dissipate heat rather than switch cleanly.`,
        );
      }
      break;
    }

    case 'op-amp': {
      for (const key of [
        'nonInvertingPin', 'invertingPin', 'outputPin', 'positiveRailPin', 'negativeRailPin',
      ] as const) {
        requirePin(`behavior.${key}`, behavior[key], 'Op-amp');
      }
      if (behavior.openLoopGain < 100) {
        error('behavior.openLoopGain', `An open-loop gain of ${behavior.openLoopGain} is far too low for an op-amp.`);
      }
      if (behavior.headroomHighVolts < 0 || behavior.headroomLowVolts < 0) {
        error('behavior', 'Rail headroom cannot be negative.');
      }
      break;
    }

    case 'source': {
      requirePin('behavior.positivePin', behavior.positivePin, 'The positive terminal');
      requirePin('behavior.negativePin', behavior.negativePin, 'The negative terminal');
      if (behavior.positivePin === behavior.negativePin) {
        error('behavior.negativePin', 'Both terminals are the same pin; the supply is shorted to itself.');
      }
      if (Math.abs(behavior.volts) > IMPLAUSIBLE_VOLTS) {
        error('behavior.volts', `${behavior.volts} V is implausible for a breadboard supply.`);
      }
      if (behavior.internalOhms > 100) {
        // Above this it is not a supply any more, it is a supply with a resistor in the way, and
        // nothing downstream of it will work as the schematic suggests.
        warn(
          'behavior.internalOhms',
          `${behavior.internalOhms} ohm of internal resistance would collapse under any real load.`,
        );
      }
      break;
    }

    case 'potentiometer': {
      for (const key of ['terminalAPin', 'wiperPin', 'terminalBPin'] as const) {
        requirePin(`behavior.${key}`, behavior[key], 'Potentiometer');
      }
      if (new Set([behavior.terminalAPin, behavior.wiperPin, behavior.terminalBPin]).size !== 3) {
        error('behavior', 'A potentiometer needs three distinct terminals.');
      }
      requireState('behavior.state', behavior.state, 'Potentiometer');
      break;
    }

    case 'diode': {
      requirePin('behavior.anodePin', behavior.anodePin, 'Diode');
      requirePin('behavior.cathodePin', behavior.cathodePin, 'Diode');
      if (behavior.anodePin === behavior.cathodePin) {
        error('behavior.cathodePin', 'A diode shorted to itself is a wire.');
      }
      // Beyond this the junction stops behaving like silicon and Newton has to work for a result
      // that means nothing anyway.
      if (behavior.emissionCoefficient > 4) {
        warn(
          'behavior.emissionCoefficient',
          `${behavior.emissionCoefficient} is far outside the 1-2 range real diodes occupy.`,
        );
      }
      break;
    }

    case 'capacitor': {
      requirePin('behavior.pinA', behavior.pinA, 'Capacitor');
      requirePin('behavior.pinB', behavior.pinB, 'Capacitor');
      if (behavior.pinA === behavior.pinB) {
        error('behavior.pinB', 'Both plates are the same pin.');
      }
      // A farad in a breadboard part is a supercapacitor, and almost always microfarads written
      // as farads -- the same unit slip that turns 20 mA into 20 A.
      if (behavior.farads >= 1) {
        warn('behavior.farads', `${behavior.farads} F is enormous. Microfarads read as farads?`);
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
  if (limits.pinMaxAmps !== undefined) {
    // The bound depends on what the part is. A power MOSFET carrying 47 A is a datasheet fact; a
    // sensor claiming the same is a milliamp figure read as amps, and that distinction cannot be
    // made from the number alone.
    const isPowerDevice = ['mosfet', 'transistor'].includes(manifest.behavior.kind);
    const ceiling = isPowerDevice ? IMPLAUSIBLE_PIN_AMPS : SUSPICIOUS_PIN_AMPS;

    if (limits.pinMaxAmps > ceiling) {
      error(
        'limits.pinMaxAmps',
        isPowerDevice
          ? `${limits.pinMaxAmps} A per pin is implausible for any breadboard part.`
          : `${limits.pinMaxAmps} A per pin is implausible for a ${manifest.category}. Milliamps read as amps?`,
      );
    } else if (!isPowerDevice && limits.pinMaxAmps > 1) {
      warn('limits.pinMaxAmps', `${limits.pinMaxAmps} A per pin is high for a ${manifest.category}; worth checking.`);
    }
  }
  // Only worth saying for a part that has a supply to exceed. A two-terminal passive has no rail,
  // and demanding one produces a warning nobody can act on.
  if (limits.vccMaxVolts === undefined && hasPower) {
    warn('limits.vccMaxVolts', 'No absolute maximum supply voltage, so over-voltage cannot be detected.');
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/** Format issues for a log or a CLI. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `${i.severity === 'error' ? 'ERROR' : 'warn '} ${i.path}: ${i.message}`).join('\n');
}
