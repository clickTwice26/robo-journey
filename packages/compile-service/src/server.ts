/**
 * The HTTP service.
 *
 * Everything the browser cannot do itself: compiling sketches, holding the Gemini key, accounts,
 * the queue, and project storage. Postgres is the source of truth; Redis holds the two things that
 * are better off ephemeral and shared.
 *
 * Start-up order is deliberate. Configuration is validated first, so a missing variable fails in a
 * message rather than a stack trace. Then the database is waited for and migrated -- under an
 * advisory lock, so several instances starting together do not race. Only then does the server
 * accept a request, which is what makes the readiness probe meaningful rather than decorative.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { AccountStore, createPool, migrate, waitForDatabase } from '@robo-journey/accounts';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { registerDatasheetRoutes } from './datasheet-route.js';
import { registerAuthRoutes } from './auth-routes.js';
import { createGuards } from './session-guard.js';
import { CompileCache, createRedis, redisHealthy } from './redis.js';
import { describeConfig, loadConfig, type Config } from './config.js';
import {
  ArduinoCompiler,
  ToolchainUnavailableError,
  type CompileRequest,
  type CompileResult,
} from './compiler.js';

export interface ServerParts {
  readonly app: FastifyInstance;
  readonly pool: Pool;
  readonly redis: Redis;
  readonly config: Config;
  /** Close everything in the right order. Idempotent. */
  close(): Promise<void>;
}

export interface CreateServerOptions {
  readonly config?: Config;
  readonly compiler?: ArduinoCompiler;
  /** Supplied by tests, which bring their own throwaway instances. */
  readonly pool?: Pool;
  readonly redis?: Redis;
  /** Overrides for the capacity policy, for tests that cannot wait an hour. */
  readonly access?: { now?: () => number };
}

export async function createServer(options: CreateServerOptions = {}): Promise<ServerParts> {
  const config = options.config ?? loadConfig();

  const pool =
    options.pool ??
    createPool({
      url: config.DATABASE_URL,
      poolSize: config.RJ_DB_POOL_SIZE,
      statementTimeoutMs: config.RJ_DB_STATEMENT_TIMEOUT_MS,
      applicationName: 'robo-journey-service',
      ssl: config.RJ_DB_SSL,
    });

  const redis = options.redis ?? createRedis({ url: config.REDIS_URL, keyPrefix: config.RJ_REDIS_PREFIX });

  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Datasheets arrive as base64 and run to a few megabytes; the 1 MB default rejects every real
    // one. Still bounded, because an unbounded body limit is a way to exhaust memory.
    bodyLimit: 32 * 1024 * 1024,
    // Only where something in front is actually setting the header. Trusting it otherwise lets any
    // client claim any address and every per-address limit becomes decorative.
    trustProxy: config.RJ_TRUST_PROXY,
    // Correlates every log line for a request, including ones from deep inside a handler.
    genReqId: () => crypto.randomUUID(),
  });

  const store = new AccountStore(pool, {
    capacity: config.RJ_ACCESS_CAPACITY,
    sessionMs: config.RJ_ACCESS_SESSION_MINUTES * 60 * 1000,
    minCooldownMs: config.RJ_ACCESS_COOLDOWN_MIN_MINUTES * 60 * 1000,
    maxCooldownMs: config.RJ_ACCESS_COOLDOWN_MAX_MINUTES * 60 * 1000,
    idleMs: config.RJ_ACCESS_IDLE_MINUTES * 60 * 1000,
    ...(options.access?.now ? { now: options.access.now } : {}),
  });
  const guards = createGuards(store);
  const compiler = options.compiler ?? new ArduinoCompiler({ mode: config.RJ_COMPILER_MODE });
  const cache = new CompileCache(
    redis,
    config.RJ_COMPILE_CACHE_TTL_SECONDS,
    config.RJ_COMPILE_CACHE_MAX_BYTES,
  );

  registerProbes(app, { pool, redis, config });

  // One scope for everything that reads a cookie, which is everything except the probes.
  // Registering the cookie plugin here rather than inside the auth routes is what lets the
  // compiler and the extractor check for a seat as well.
  //
  // Prefixed `/api`, matching what the browser asks for in development through Vite's proxy. The
  // two used to differ -- the proxy stripped the prefix -- which works right up until the built
  // app is served from the same origin and every call 404s.
  await app.register(
    async (scope) => {
      await scope.register(cookie);
      registerAuthRoutes(scope, { store, guards, redis });
      registerDatasheetRoutes(scope, { guards });
      registerCompileRoute(scope, { guards, compiler, cache });
    },
    { prefix: '/api' },
  );

  if (config.RJ_STATIC_DIR) registerStatic(app, config.RJ_STATIC_DIR);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Order matters: stop taking requests, then let in-flight work finish against connections that
    // are still open, then close them. Closing the pool first turns a graceful shutdown into a
    // burst of errors for requests that were nearly done.
    await app.close();
    if (!options.redis) redis.disconnect();
    if (!options.pool) await pool.end();
  };

  return { app, pool, redis, config, close };
}

/**
 * Liveness and readiness, which answer different questions.
 *
 * Liveness is "is this process working" -- if it fails, restarting helps. Readiness is "can this
 * process serve traffic", which includes its dependencies. Wiring a load balancer to a health
 * check that pings the database is a way to take every instance out of rotation at once when the
 * database hiccups; wiring a restart policy to one is a way to turn that into a crash loop.
 */
function registerProbes(
  app: FastifyInstance,
  { pool, redis, config }: { pool: Pool; redis: Redis; config: Config },
): void {
  app.get('/health', async () => ({ ok: true }));

  app.get('/ready', async (_request, reply) => {
    const [database, cache] = await Promise.all([
      pool
        .query('SELECT 1')
        .then(() => true)
        .catch(() => false),
      redisHealthy(redis),
    ]);

    const ok = database && cache;
    return reply.status(ok ? 200 : 503).send({ ok, database, cache });
  });

  // Configuration as the process actually sees it, minus anything secret. The first question when
  // a deploy behaves oddly is what it is configured with, and guessing from a template is slow.
  app.get('/info', async () => describeConfig(config));
}

/**
 * Serve the built studio.
 *
 * Same origin as the API, so there is no CORS to configure and no proxy in front. Hashed assets
 * are immutable and cached for a year; `index.html` never is, or a deploy would leave browsers
 * loading an old shell that asks for assets which no longer exist.
 */
function registerStatic(app: FastifyInstance, root: string): void {
  void app.register(fastifyStatic, {
    root,
    index: ['index.html'] as string[],
    setHeaders: (response, path) => {
      // Hashed asset filenames change whenever their content does, so they can be cached
      // indefinitely. `index.html` never can: a deploy would otherwise leave browsers holding an
      // old shell that asks for asset files which no longer exist.
      const value = path.endsWith('.html')
        ? 'no-cache'
        : path.includes('/assets/')
          ? 'public, max-age=31536000, immutable'
          : null;
      if (!value) return;

      // Typed as a reply, handed the raw response at run time. Supporting both is two lines and
      // avoids a cast that would be wrong in whichever direction the types settle.
      const target = response as unknown as {
        setHeader?(name: string, value: string): void;
        header?(name: string, value: string): void;
      };
      if (target.setHeader) target.setHeader('Cache-Control', value);
      else target.header?.('Cache-Control', value);
    },
  });

  // A single-page app owns its routes, so anything that is not an API path or a real file falls
  // back to the shell rather than to a 404.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method !== 'GET' || request.url.startsWith('/api')) {
      return reply.status(404).send({ error: 'Not found.' });
    }
    return reply.sendFile('index.html');
  });
}

/** The compiler: the tool itself, so it needs a seat rather than merely an account. */
function registerCompileRoute(
  app: FastifyInstance,
  {
    guards,
    compiler,
    cache,
  }: { guards: ReturnType<typeof createGuards>; compiler: ArduinoCompiler; cache: CompileCache },
): void {
  app.post<{ Body: CompileRequest }>('/compile', async (request, reply) => {
    if (!(await guards.requireSeat(request, reply))) return reply;

    const body = request.body;
    if (!body || !Array.isArray(body.files) || body.files.length === 0) {
      return reply.status(400).send({ error: 'Expected { files: [{ name, contents }] }' });
    }

    // Content-addressed, so a hit is exact rather than a guess about whether two sketches match.
    // Checked before the compile, which is the whole point: a cold AVR build is about two seconds.
    const hash = compiler.hashRequest(body);
    const cached = await cache.get<CompileResponse>(hash);
    if (cached) return reply.header('x-compile-cache', 'hit').send(cached);

    try {
      const result = await compiler.compile(body);
      const response = toResponse(result);
      if (result.ok) await cache.set(hash, response);
      return reply.header('x-compile-cache', 'miss').send(response);
    } catch (error) {
      request.log.error(error);
      // 503, not 500: the service is fine, the toolchain behind it is not, and the client should
      // say so rather than reporting a generic failure.
      const status = error instanceof ToolchainUnavailableError ? 503 : 500;
      return reply.status(status).send({ error: (error as Error).message });
    }
  });
}

interface CompileResponse {
  ok: boolean;
  hash: string;
  diagnostics: CompileResult['diagnostics'];
  hex?: string;
  elf?: string;
}

function toResponse(result: CompileResult): CompileResponse {
  return {
    ok: result.ok,
    hash: result.hash,
    diagnostics: result.diagnostics,
    ...(result.hex ? { hex: result.hex } : {}),
    // ELF goes over the wire base64-encoded; it feeds the symbol map, not the emulator.
    ...(result.elf ? { elf: Buffer.from(result.elf).toString('base64') } : {}),
  };
}

/**
 * Start the service.
 *
 * Migrations run here rather than in an entrypoint script so there is exactly one path into a
 * running service, and it is the same one in every environment.
 */
export async function start(): Promise<ServerParts> {
  const config = loadConfig();
  const parts = await createServer({ config });

  await waitForDatabase(parts.pool);
  const applied = await migrate(parts.pool);
  if (applied.length > 0) parts.app.log.info({ applied }, 'migrations applied');

  await parts.app.listen({ port: config.RJ_SERVICE_PORT, host: config.RJ_SERVICE_HOST });
  return parts;
}
