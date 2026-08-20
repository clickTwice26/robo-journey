/**
 * Configuration, validated once at start-up.
 *
 * Every value the service needs is read and checked here, before anything connects to anything.
 * The alternative -- reading `process.env` where it is used -- means a missing database URL
 * surfaces as a connection error on the first request that happens to need it, hours after the
 * deploy, in a stack trace that does not mention configuration at all.
 *
 * So: fail at boot, with a message naming the variable. A container that will not start is a
 * problem someone fixes in a minute; one that starts and is subtly wrong is a problem someone
 * finds next week.
 */
import { z } from 'zod';

/** Ports well away from the crowded defaults, so this runs beside other projects. */
const DEFAULT_PORT = 28610;

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  RJ_SERVICE_PORT: z.coerce.number().int().positive().max(65535).default(DEFAULT_PORT),
  RJ_SERVICE_HOST: z.string().default('0.0.0.0'),

  /**
   * Postgres connection string.
   *
   * Required, with no default. A default here would be a footgun: a production deploy missing this
   * variable would quietly come up against localhost and appear to work, with an empty database.
   */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (postgres://user:pass@host:5432/db)'),
  RJ_DB_POOL_SIZE: z.coerce.number().int().positive().max(100).default(10),
  RJ_DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  RJ_DB_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required (redis://host:6379)'),
  RJ_REDIS_PREFIX: z.string().default('rj:'),

  /** Capacity policy. Ten at once, an hour each, twenty minutes between turns. */
  RJ_ACCESS_CAPACITY: z.coerce.number().int().positive().max(1000).default(10),
  RJ_ACCESS_SESSION_MINUTES: z.coerce.number().positive().default(60),
  RJ_ACCESS_COOLDOWN_MINUTES: z.coerce.number().positive().default(20),
  RJ_ACCESS_IDLE_MINUTES: z.coerce.number().positive().default(2),

  /**
   * How the compiler runs `arduino-cli`.
   *
   * `local` runs the binary on PATH, which is what the container image provides. `docker` runs the
   * pinned image, for a developer machine with Docker but no toolchain installed. Running the
   * service in a container *and* choosing `docker` would mean mounting the host's Docker socket,
   * which hands the container root on the host -- so the container image sets `local`.
   */
  RJ_COMPILER_MODE: z.enum(['local', 'docker']).default('docker'),
  RJ_COMPILE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(24 * 60 * 60),
  RJ_COMPILE_CACHE_MAX_BYTES: z.coerce.number().int().positive().default(4 * 1024 * 1024),

  /** Directory of built studio assets to serve. Unset in development, where Vite serves them. */
  RJ_STATIC_DIR: z.string().optional(),

  /**
   * Set when the service sits behind a load balancer or ingress.
   *
   * Off by default and that is the safe direction: trusting `X-Forwarded-For` when nothing sets it
   * lets any client claim any address, and every per-address rate limit becomes trivially evaded.
   */
  RJ_TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /** Gemini key for datasheet extraction. Optional; the feature reports itself unavailable. */
  GEMINI_API_KEY: z.string().optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = Readonly<z.infer<typeof Env>>;

export class ConfigError extends Error {}

/**
 * Read and validate the environment.
 *
 * Every problem is reported at once. Fixing one missing variable, redeploying, and discovering the
 * next one is a slow way to spend an afternoon.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = Env.safeParse(env);
  if (result.success) return Object.freeze(result.data);

  const problems = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new ConfigError(`Invalid configuration:\n${problems}`);
}

/** Values safe to log or return from an endpoint. Never anything secret. */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    env: config.NODE_ENV,
    port: config.RJ_SERVICE_PORT,
    compiler: config.RJ_COMPILER_MODE,
    capacity: config.RJ_ACCESS_CAPACITY,
    sessionMinutes: config.RJ_ACCESS_SESSION_MINUTES,
    cooldownMinutes: config.RJ_ACCESS_COOLDOWN_MINUTES,
    idleMinutes: config.RJ_ACCESS_IDLE_MINUTES,
    // Whether it is set, never what it is.
    datasheetExtraction: Boolean(config.GEMINI_API_KEY),
    staticAssets: Boolean(config.RJ_STATIC_DIR),
  };
}
