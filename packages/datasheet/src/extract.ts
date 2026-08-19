/**
 * Datasheet to component manifest, via Gemini.
 *
 * Server-side only. The API key must never reach the browser, so this package is imported by the
 * service and never by the app.
 *
 * The pipeline is deliberately distrustful: generate, validate structurally with zod, validate
 * semantically against physics, and hand any failures back for repair. A model that has been told
 * exactly what is wrong fixes it far more reliably than one asked to try again, and the loop is
 * bounded so a hopeless input fails rather than spins.
 */
import { GoogleGenAI } from '@google/genai';
import {
  parseManifest,
  validateManifest,
  type ComponentManifest,
  type ValidationIssue,
} from '@robo-journey/parts';
import { PROMPT_VERSION, SYSTEM_INSTRUCTION, buildPrompt, buildRepairPrompt } from './prompt.js';

/**
 * Default model.
 *
 * A datasheet is a dense PDF full of tables, and extraction happens once per component, so accuracy
 * matters far more than latency. Overridable, because the model list moves.
 */
export const DEFAULT_MODEL = 'gemini-3.7-flash';

/** How many repair rounds before giving up. */
const MAX_ATTEMPTS = 3;

/**
 * Transient API failures worth retrying.
 *
 * Rate limiting arrives as 429, capacity problems as 503, and -- observed in practice against a
 * key that worked seconds earlier and seconds later -- transient throttling can surface as 403.
 * Treating any of these as a hard failure would make extraction feel broken when it is merely
 * busy.
 */
const RETRYABLE_STATUSES = new Set([403, 429, 500, 502, 503, 504]);
const MAX_TRANSIENT_RETRIES = 4;
/** First backoff, doubling each time: 0.5 s, 1 s, 2 s, 4 s. */
const BASE_BACKOFF_MS = 500;

function statusOf(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type DatasheetInput =
  | { readonly kind: 'pdf'; readonly data: Uint8Array; readonly filename?: string }
  | { readonly kind: 'text'; readonly text: string };

export interface ExtractOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly input: DatasheetInput;
  /** A part number or description from the user, when they have one. */
  readonly hint?: string;
  /** Overridable for tests. */
  readonly now?: () => Date;
}

export interface ExtractResult {
  readonly ok: boolean;
  readonly manifest?: ComponentManifest;
  /** Semantic issues, present even on success -- warnings are the interesting part. */
  readonly issues: readonly ValidationIssue[];
  /** Why extraction failed, when it did. */
  readonly error?: string;
  /** Model output from the final attempt, for debugging. */
  readonly raw: string;
  readonly attempts: number;
  readonly model: string;
}

export class DatasheetExtractionError extends Error {}

/** Models sometimes wrap JSON in a fence despite instructions. Strip it rather than fail. */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();

  // Take from the first brace to the last, so any stray prose either side is discarded.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return candidate;
  return candidate.slice(start, end + 1);
}

/** Turn zod and semantic failures into instructions a model can act on. */
function problemsFrom(error: unknown, issues: readonly ValidationIssue[]): string[] {
  const problems: string[] = [];

  if (error && typeof error === 'object' && 'issues' in error) {
    for (const issue of (error as { issues: { path: (string | number)[]; message: string }[] }).issues) {
      problems.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  } else if (error instanceof Error) {
    problems.push(error.message);
  }

  for (const issue of issues) {
    if (issue.severity === 'error') problems.push(`${issue.path}: ${issue.message}`);
  }

  return problems;
}

/**
 * Extract a manifest from a datasheet.
 *
 * Never throws for a bad datasheet or an unusable model response -- those are outcomes the caller
 * shows the user. Only a missing key or an unreachable API throws.
 */
export async function extractManifest(options: ExtractOptions): Promise<ExtractResult> {
  if (!options.apiKey) {
    throw new DatasheetExtractionError('No Gemini API key configured (set GEMINI_API_KEY).');
  }

  const model = options.model ?? DEFAULT_MODEL;
  const ai = new GoogleGenAI({ apiKey: options.apiKey });
  const now = options.now ?? (() => new Date());

  const initialParts = buildContentParts(options.input, options.hint);
  let contents = initialParts;
  let raw = '';
  let lastProblems: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    raw = await generateWithRetry(ai, model, contents);
    if (!raw.trim()) {
      lastProblems = ['The model returned nothing.'];
      contents = repairContents(initialParts, raw, lastProblems);
      continue;
    }

    let manifest: ComponentManifest;
    try {
      manifest = parseManifest(JSON.parse(extractJson(raw)));
    } catch (error) {
      lastProblems = problemsFrom(error, []);
      if (lastProblems.length === 0) lastProblems = ['The output was not valid JSON.'];
      contents = repairContents(initialParts, raw, lastProblems);
      continue;
    }

    const validation = validateManifest(manifest);
    if (!validation.ok) {
      lastProblems = problemsFrom(null, validation.issues);
      contents = repairContents(initialParts, raw, lastProblems);
      continue;
    }

    // Provenance is stamped here rather than trusted from the model: where a manifest came from is
    // a fact about this call, not something the model gets to assert.
    const stamped: ComponentManifest = {
      ...manifest,
      provenance: {
        ...manifest.provenance,
        source: 'datasheet-ai',
        model: `${model} (prompt v${PROMPT_VERSION})`,
        extractedAt: now().toISOString(),
        // Never verified on arrival. A human has to say so.
        verified: false,
      },
    };

    return {
      ok: true,
      manifest: stamped,
      issues: validation.issues,
      raw,
      attempts: attempt,
      model,
    };
  }

  return {
    ok: false,
    issues: [],
    error: `Could not produce a valid manifest after ${MAX_ATTEMPTS} attempts. Last problems: ${lastProblems.join('; ')}`,
    raw,
    attempts: MAX_ATTEMPTS,
    model,
  };
}

/**
 * One generation, retrying transient failures with exponential backoff.
 *
 * Distinct from the repair loop above: that one fixes a *bad answer*, this one survives a *busy
 * API*. Conflating them would waste repair attempts on failures that had nothing to do with the
 * content.
 */
async function generateWithRetry(
  ai: GoogleGenAI,
  model: string,
  contents: ContentPart[],
): Promise<string> {
  let lastError: unknown;

  for (let retry = 0; retry <= MAX_TRANSIENT_RETRIES; retry++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          // Extraction is a reading task, not a creative one: the same datasheet should give the
          // same manifest twice.
          temperature: 0,
        },
      });
      return response.text ?? '';
    } catch (error) {
      lastError = error;
      const status = statusOf(error);
      if (status === undefined || !RETRYABLE_STATUSES.has(status) || retry === MAX_TRANSIENT_RETRIES) {
        break;
      }
      await sleep(BASE_BACKOFF_MS * 2 ** retry);
    }
  }

  const status = statusOf(lastError);
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new DatasheetExtractionError(
    status === 401 || status === 400
      ? `Gemini rejected the request (${status}). Check GEMINI_API_KEY. ${detail}`
      : `Gemini request failed after ${MAX_TRANSIENT_RETRIES + 1} attempts: ${detail}`,
  );
}

type ContentPart = { text: string } | { inlineData: { mimeType: string; data: string } };

function buildContentParts(input: DatasheetInput, hint?: string): ContentPart[] {
  if (input.kind === 'pdf') {
    // Gemini reads PDFs natively, which matters: a datasheet's meaning lives in its tables and
    // pin drawings, and flattening it to text loses exactly the parts worth extracting.
    return [
      { inlineData: { mimeType: 'application/pdf', data: Buffer.from(input.data).toString('base64') } },
      { text: buildPrompt({ hint }) },
    ];
  }
  return [{ text: buildPrompt({ hint, text: input.text }) }];
}

function repairContents(
  original: ContentPart[],
  previous: string,
  problems: readonly string[],
): ContentPart[] {
  return [...original, { text: buildRepairPrompt(previous, problems) }];
}
