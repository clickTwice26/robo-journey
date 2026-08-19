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
