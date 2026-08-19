/**
 * @robo-journey/datasheet
 *
 * Extracts component manifests from datasheets. Server-side only: importing this into the browser
 * would put the API key in the bundle.
 */
export {
  DEFAULT_MODEL,
  DatasheetExtractionError,
  extractJson,
  extractManifest,
} from './extract.js';
export type { DatasheetInput, ExtractOptions, ExtractResult } from './extract.js';

export {
  PROMPT_VERSION,
  RULES,
  SCHEMA_GUIDE,
  SYSTEM_INSTRUCTION,
  buildPrompt,
  buildRepairPrompt,
} from './prompt.js';
