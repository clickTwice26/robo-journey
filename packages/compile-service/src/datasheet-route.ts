/**
 * Datasheet extraction endpoint.
 *
 * Lives server-side for one reason that is not negotiable: the Gemini API key must never reach the
 * browser. A bundled key is a published key, and this one belongs to the user.
 *
 * The route also enforces the limits the model call cannot -- payload size, request rate -- because
 * an extraction is expensive and a mis-clicked upload of a 200 MB file should fail here rather
 * than at the API.
 */
import type { FastifyInstance } from 'fastify';
import { extractManifest, DatasheetExtractionError } from '@robo-journey/datasheet';
import { validateManifest } from '@robo-journey/parts';
import type { Guards } from './session-guard.js';

/**
 * Largest datasheet accepted, bytes.
 *
 * Component datasheets run to a few megabytes at most; anything far larger is a mistake, and
 * sending it would cost real money before failing.
 */
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 500_000;

/** Simple per-process rate limit, since each call costs money. */
const MIN_INTERVAL_MS = 1500;
let lastRequestAt = 0;

export interface ExtractBody {
  /** Base64 PDF, or plain datasheet text. Exactly one. */
  pdfBase64?: string;
  text?: string;
  hint?: string;
  model?: string;
}

export interface DatasheetRouteOptions {
  readonly guards: Guards;
}

export function registerDatasheetRoutes(app: FastifyInstance, options: DatasheetRouteOptions): void {
  app.get('/datasheet/status', async () => ({
    // Whether extraction is available at all, without ever revealing the key itself.
    configured: Boolean(process.env.GEMINI_API_KEY),
  }));

  app.post<{ Body: ExtractBody }>('/datasheet/extract', async (request, reply) => {
    // An extraction costs real money, so it is squarely one of the things the seat limit exists
    // to ration.
    if (!options.guards.requireSeat(request, reply)) return reply;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return reply.status(503).send({
        error:
          'Datasheet extraction is not configured. Set GEMINI_API_KEY in the project .env and ' +
          'restart the service.',
      });
    }

    const body = request.body ?? {};
    if (!body.pdfBase64 && !body.text) {
      return reply.status(400).send({ error: 'Provide either a PDF or datasheet text.' });
    }

    if (body.text && body.text.length > MAX_TEXT_CHARS) {
      return reply.status(413).send({ error: `Datasheet text exceeds ${MAX_TEXT_CHARS} characters.` });
    }

    let data: Uint8Array | undefined;
    if (body.pdfBase64) {
      const buffer = Buffer.from(body.pdfBase64, 'base64');
      if (buffer.byteLength > MAX_PDF_BYTES) {
        return reply
          .status(413)
          .send({ error: `PDF exceeds ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB.` });
      }
      if (buffer.byteLength === 0) {
        return reply.status(400).send({ error: 'The uploaded PDF was empty.' });
      }
      data = new Uint8Array(buffer);
    }

    const since = Date.now() - lastRequestAt;
    if (since < MIN_INTERVAL_MS) {
      return reply.status(429).send({
        error: `Too many extractions. Wait ${Math.ceil((MIN_INTERVAL_MS - since) / 1000)}s.`,
      });
    }
    lastRequestAt = Date.now();

    try {
      const result = await extractManifest({
        apiKey,
        ...(body.model ? { model: body.model } : {}),
        ...(body.hint ? { hint: body.hint } : {}),
        input: data ? { kind: 'pdf', data } : { kind: 'text', text: body.text! },
      });

      if (!result.ok || !result.manifest) {
        return reply.status(422).send({
          ok: false,
          error: result.error ?? 'Extraction produced no usable manifest.',
          attempts: result.attempts,
          // The raw output helps a user see whether the datasheet was the problem.
          raw: result.raw.slice(0, 4000),
        });
      }

      // Re-validate here rather than trusting the extractor's own word: the route is the boundary
      // the app relies on, and a manifest reaching the palette unvalidated would be a silent
      // fidelity hole.
      const validation = validateManifest(result.manifest);

      return reply.send({
        ok: true,
        manifest: result.manifest,
        issues: validation.issues,
        attempts: result.attempts,
        model: result.model,
      });
    } catch (error) {
      request.log.error(error);
      const message = error instanceof DatasheetExtractionError
        ? error.message
        : `Extraction failed: ${(error as Error).message}`;
      return reply.status(502).send({ error: message });
    }
  });
}
