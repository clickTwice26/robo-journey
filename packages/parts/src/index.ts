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
  partDefinition,
} from './registry.js';
export type { BuildContext, PartCategory, PartDefinition, PartPin } from './registry.js';

export {
  ProjectSchema,
  emptyProject,
  parseProject,
  partsPluggedInto,
  splitTerminal,
  terminalId,
} from './project.js';
export type { PartInstance, Project, SketchFile, Wire } from './project.js';

export { EXAMPLES, exampleById } from './examples.js';
export type { Example } from './examples.js';
