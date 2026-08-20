/**
 * @robo-journey/parts
 *
 * Component SDK, part library, project model, and the bridge from a wired canvas to a circuit.
 */
export { buildCircuit } from './build.js';
export type { BuildOptions, BuiltCircuit } from './build.js';

export {
  ARDUINO_UNO,
  BREADBOARD_FULL,
  BREADBOARD_HALF,
  BREADBOARD_MINI,
  LED,
  PITCH_MM,
  PUSHBUTTON,
  RESISTOR,
  allParts,
  builtinParts,
  isRegistered,
  partDefinition,
  registerPart,
  registeredParts,
  unregisterPart,
} from './registry.js';
export type {
  BuildContext,
  PartAppearance,
  PartCategory,
  PartDefinition,
  PartPin,
} from './registry.js';

export {
  ProjectSchema,
  emptyProject,
  parseProject,
  partsPluggedInto,
  splitTerminal,
  terminalId,
} from './project.js';
export type { PartInstance, Project, SketchFile, Wire } from './project.js';

export { BUILTIN_MANIFESTS, installBuiltinManifests } from './builtin-manifests.js';

export { INSTRUMENTS, SCOPE_CHANNELS, parseProbeChannel, probeChannel } from './instruments.js';

export {
  CM_PER_CANVAS_MM,
  contributionAt,
  fieldAt,
  isDriven,
  reachFraction,
  reaches,
} from './environment.js';
export type { EnvironmentSource, Quantity } from './environment.js';

export { EMISSIONS, STIMULI, environmentSources, isStimulus } from './stimulus.js';
export type { Emission } from './stimulus.js';

export { LIBRARY, LIBRARY_PROJECTS, libraryProject } from './library.js';
export type { LibraryGroup, LibraryProject } from './library.js';

// --- Component manifests -------------------------------------------------------------------------

export { ComponentManifestSchema, parseManifest } from './manifest.js';
export type {
  Behavior,
  ComponentManifest,
  Limits,
  ManifestPin,
  PinModel,
  Provenance,
  StateVariable,
} from './manifest.js';

export { formatIssues, validateManifest } from './manifest-validate.js';
export type { IssueSeverity, ValidationIssue, ValidationResult } from './manifest-validate.js';

export {
  ComponentState,
  ManifestDevice,
  manifestToPartDefinition,
} from './manifest-runtime.js';
