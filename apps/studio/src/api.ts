/**
 * Compile service client.
 *
 * The browser cannot run avr-gcc, so sketch sources go to the local service and come back as Intel
 * HEX plus diagnostics. Vite proxies `/api/compile` to it in development; the Tauri build will call
 * the same compiler in-process and this module is the only thing that has to change.
 */
import type { Diagnostic } from './store.ts';

export interface CompileResponse {
  ok: boolean;
  hash: string;
  diagnostics: Diagnostic[];
  hex?: string;
  elf?: string;
}

export class CompileUnavailableError extends Error {
  constructor() {
    super(
      'Compile service unreachable. Start it with: npm run start -w @robo-journey/compile-service',
    );
    this.name = 'CompileUnavailableError';
  }
}

export async function compileSketch(
  files: { name: string; contents: string }[],
): Promise<CompileResponse> {
  let response: Response;
  try {
    response = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
  } catch {
    throw new CompileUnavailableError();
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Compile service returned ${response.status}`);
  }

  return (await response.json()) as CompileResponse;
}

// --- Datasheet extraction -------------------------------------------------------------------------

export interface ExtractIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ExtractResponse {
  ok: boolean;
  manifest?: unknown;
  issues?: ExtractIssue[];
  attempts?: number;
  model?: string;
  error?: string;
  raw?: string;
}

/** Whether the service has an API key. Never returns the key itself. */
export async function datasheetStatus(): Promise<{ configured: boolean }> {
  try {
    const response = await fetch('/api/datasheet/status');
    if (!response.ok) return { configured: false };
    return (await response.json()) as { configured: boolean };
  } catch {
    return { configured: false };
  }
}

export interface ExtractRequest {
  /** Base64 PDF, or plain datasheet text. */
  pdfBase64?: string;
  text?: string;
  hint?: string;
}

/**
 * Extract a component manifest from a datasheet.
 *
 * Runs on the service, not here: the API key is the whole reason this is not a direct call.
 */
export async function extractComponent(request: ExtractRequest): Promise<ExtractResponse> {
  let response: Response;
  try {
    response = await fetch('/api/datasheet/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    throw new CompileUnavailableError();
  }

  const body = (await response.json().catch(() => ({}))) as ExtractResponse;
  if (!response.ok && !body.error) {
    throw new Error(`Extraction service returned ${response.status}`);
  }
  return body;
}
