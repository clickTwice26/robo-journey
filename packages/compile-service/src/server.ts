/**
 * HTTP front end for the compiler.
 *
 * Development only: the browser cannot run avr-gcc, so the studio posts sketch sources here and
 * gets firmware back. The desktop build calls `ArduinoCompiler` directly and never starts a server.
 */
import Fastify from 'fastify';
import {
  ArduinoCompiler,
  ToolchainUnavailableError,
  type CompileRequest,
  type CompileResult,
} from './compiler.js';

const PORT = Number(process.env.PORT ?? 4747);
const HOST = process.env.HOST ?? '127.0.0.1';

/**
 * Compiled output is content-addressed, so a cache hit is exact. Sketches are edited far more often
 * than they change meaningfully (save on keystroke), and a cold AVR compile is ~2 s.
 */
const cache = new Map<string, CompileResult>();
const CACHE_LIMIT = 64;

export function createServer(compiler = new ArduinoCompiler()) {
  const app = Fastify({ logger: true });

  app.post<{ Body: CompileRequest }>('/compile', async (request, reply) => {
    const body = request.body;
    if (!body || !Array.isArray(body.files) || body.files.length === 0) {
      return reply.status(400).send({ error: 'Expected { files: [{ name, contents }] }' });
    }

    try {
      const result = await compiler.compile(body);

      if (result.ok) {
        if (cache.size >= CACHE_LIMIT) {
          const oldest = cache.keys().next();
          if (!oldest.done) cache.delete(oldest.value);
        }
        cache.set(result.hash, result);
      }

      return reply.send({
        ok: result.ok,
        hash: result.hash,
        diagnostics: result.diagnostics,
        hex: result.hex,
        // ELF goes over the wire base64-encoded; it feeds the symbol map, not the emulator.
        elf: result.elf ? Buffer.from(result.elf).toString('base64') : undefined,
      });
    } catch (error) {
      request.log.error(error);
      // 503, not 500: the service is fine, the toolchain behind it is not, and the client should
      // say so rather than reporting a generic failure.
      const status = error instanceof ToolchainUnavailableError ? 503 : 500;
      return reply.status(status).send({ error: (error as Error).message });
    }
  });

  app.get('/health', async () => ({ ok: true }));

  return app;
}

// Start only when run directly, so importing this module in tests does not bind a port.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\0')) {
  const app = createServer();
  app.listen({ port: PORT, host: HOST }).catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
}
