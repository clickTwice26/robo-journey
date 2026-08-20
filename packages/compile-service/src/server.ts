/**
 * HTTP front end for the compiler.
 *
 * Development only: the browser cannot run avr-gcc, so the studio posts sketch sources here and
 * gets firmware back. The desktop build calls `ArduinoCompiler` directly and never starts a server.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerDatasheetRoutes } from './datasheet-route.js';
import { registerAuthRoutes } from './auth-routes.js';
import { createGuards } from './session-guard.js';
import { AccountStore, type AccessConfig } from '@robo-journey/accounts';
import {
  ArduinoCompiler,
  ToolchainUnavailableError,
  type CompileRequest,
  type CompileResult,
} from './compiler.js';

/**
 * Ports.
 *
 * Deliberately away from the crowded defaults -- 3000, 5000, 5173, 8080 -- so running this
 * alongside other projects does not need anyone to remember which one grabbed a port first.
 * Overridable through `.env`; if you change them there, update `.claude/launch.json` to match.
 */
const PORT = Number(process.env.RJ_SERVICE_PORT ?? process.env.PORT ?? 28610);
const HOST = process.env.HOST ?? '127.0.0.1';

/**
 * Compiled output is content-addressed, so a cache hit is exact. Sketches are edited far more often
 * than they change meaningfully (save on keystroke), and a cold AVR compile is ~2 s.
 */
const cache = new Map<string, CompileResult>();
const CACHE_LIMIT = 64;

/**
 * Where the account database lives.
 *
 * Beside the project by default, so it is obvious, backed up with everything else, and deleted by
 * deleting the folder. `:memory:` in tests.
 */
const DATABASE_FILE = process.env.RJ_DATABASE ?? 'robo-journey.db';

/**
 * Capacity limits, overridable from the environment.
 *
 * Ten at once, an hour each, twenty minutes before you can queue again. Tunable without a code
 * change because the right numbers depend on the machine this runs on, but the defaults are the
 * policy.
 */
function accessConfigFromEnv(): AccessConfig {
  const number = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };

  const config: AccessConfig = {};
  const capacity = number('RJ_ACCESS_CAPACITY');
  const sessionMinutes = number('RJ_ACCESS_SESSION_MINUTES');
  const cooldownMinutes = number('RJ_ACCESS_COOLDOWN_MINUTES');
  return {
    ...config,
    ...(capacity !== undefined ? { capacity } : {}),
    ...(sessionMinutes !== undefined ? { sessionMs: sessionMinutes * 60 * 1000 } : {}),
    ...(cooldownMinutes !== undefined ? { cooldownMs: cooldownMinutes * 60 * 1000 } : {}),
  };
}

export function createServer(
  compiler = new ArduinoCompiler(),
  databaseFile = DATABASE_FILE,
  accessConfig: AccessConfig = accessConfigFromEnv(),
) {
  // Datasheets are megabytes as base64; the default 1 MB body limit would reject every real one.
  const app = Fastify({ logger: true, bodyLimit: 32 * 1024 * 1024 });

  const store = new AccountStore(databaseFile, accessConfig);
  const guards = createGuards(store);

  app.get('/health', async () => ({ ok: true }));

  // One scope for everything that reads a cookie, which is everything except the health check.
  // Registering the cookie plugin here rather than inside the auth routes is what lets the
  // compiler and the extractor check for a seat as well.
  void app.register(async (instance) => {
    await instance.register(cookie);

    registerAuthRoutes(instance, { store, guards });
    registerDatasheetRoutes(instance, { guards });
    registerCompileRoute(instance);
  });

  /** The compiler: the tool itself, so it needs a seat rather than merely an account. */
  function registerCompileRoute(scope: FastifyInstance): void {
  scope.post<{ Body: CompileRequest }>('/compile', async (request, reply) => {
    if (!guards.requireSeat(request, reply)) return reply;

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
  }

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
