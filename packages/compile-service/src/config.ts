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

  /** Capacity policy. Ten at once, an hour each. */
  RJ_ACCESS_CAPACITY: z.coerce.number().int().positive().max(1000).default(10),
  RJ_ACCESS_SESSION_MINUTES: z.coerce.number().positive().default(60),
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

  /** Gemini key for the AI features. Optional; they report themselves unavailable without it. */
  GEMINI_API_KEY: z.string().optional(),

  /**
   * Credits a new account starts with.
   *
   * Granted once the address is confirmed rather than at signup, for the same reason a seat is:
   * accounts are free, and an allowance handed to an unconfirmed one is an allowance handed to
   * anybody who can type an address.
   */
  RJ_SIGNUP_CREDITS: z.coerce.number().int().nonnegative().default(100),

  /**
   * Whether an address has to be proved before an account can take a seat.
   *
   * On by default, and it is the reason the queue means anything: accounts are free, so a
   * per-account limit is only a limit if accounts cost something to make. A mailbox is that
   * cost.
   */
  RJ_REQUIRE_VERIFIED_EMAIL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /**
   * Where the app is reached from, for the links in outgoing mail.
   *
   * Cannot be inferred from a request: mail is sent during one, but the link is clicked hours
   * later from somewhere else, and a `Host` header is attacker-controlled -- taking the link's
   * origin from it is how a verification mail ends up pointing at somebody else's site.
   */
  RJ_PUBLIC_URL: z.string().url().default('http://localhost:28610'),

  /**
   * SMTP. Absent means links are printed to the log instead, which is how local development works.
   *
   * Unprefixed, like `DATABASE_URL` and `REDIS_URL`: these name a piece of standard infrastructure
   * rather than anything about this application, and every host that hands out mail credentials
   * calls them this. `RJ_SMTP_*` is accepted as well, for anyone who copied the older template.
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('robo-journey <no-reply@localhost>'),

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
/**
 * Accept the older `RJ_SMTP_*` spellings.
 *
 * The unprefixed names are canonical because that is what every mail host calls them and what
 * anyone pasting credentials will already have. Only filled in where the canonical name is absent,
 * so setting both is not ambiguous.
 */
const SMTP_ALIASES: ReadonlyArray<readonly [canonical: string, legacy: string]> = [
  ['SMTP_HOST', 'RJ_SMTP_HOST'],
  ['SMTP_PORT', 'RJ_SMTP_PORT'],
  ['SMTP_SECURE', 'RJ_SMTP_SECURE'],
  ['SMTP_USER', 'RJ_SMTP_USER'],
  ['SMTP_PASSWORD', 'RJ_SMTP_PASS'],
  ['SMTP_FROM', 'RJ_MAIL_FROM'],
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // An unset variable and one set to nothing are the same intent, and Compose has no way to
  // express the first: `SMTP_SECURE: ${SMTP_SECURE:-}` passes an empty string. Dropping them lets
  // defaults and optionals apply instead of failing validation on "".
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') merged[key] = value;
  }

  for (const [canonical, legacy] of SMTP_ALIASES) {
    if (merged[canonical] === undefined && merged[legacy] !== undefined) {
      merged[canonical] = merged[legacy];
    }
  }

  // Port 465 is implicit TLS and every other SMTP port is STARTTLS. Nobody sets both the port and
  // a separate flag saying what it implies, and getting it wrong fails in a way that reads like
  // bad credentials rather than like a protocol mismatch -- so it is derived unless stated.
  if (merged.SMTP_SECURE === undefined && merged.SMTP_PORT === '465') {
    merged.SMTP_SECURE = 'true';
  }

  const result = Env.safeParse(merged);
  if (result.success) {
    const config = result.data;

    // A production deployment that demands verified addresses and cannot send mail is one where
    // nobody can ever get in, and it would look like a working deploy until the first signup.
    // Better to refuse to start.
    if (config.NODE_ENV === 'production' && config.RJ_REQUIRE_VERIFIED_EMAIL && !config.SMTP_HOST) {
      throw new ConfigError(
        'Email verification is required but no mail server is configured: set SMTP_HOST (and ' +
          'SMTP_FROM), or set RJ_REQUIRE_VERIFIED_EMAIL=false to run without it.\n' +
          'Without one, nobody who signs up can ever take a seat.',
      );
    }
    return Object.freeze(config);
  }

  const problems = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new ConfigError(`Invalid configuration:\n${problems}`);
}

/**
 * Things worth saying at start-up that are not worth refusing to start over.
 *
 * The distinction matters and I got it wrong twice: a fatal check that fires on a configuration
 * somebody is legitimately running -- testing real mail against a local stack, say -- is not a
 * safety net, it is a crash loop. Fatal is for states where nothing works at all; everything else
 * belongs here, where it is loud and ignorable.
 */
export function configWarnings(config: Config): string[] {
  const warnings: string[] = [];

  const localLink = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(
    config.RJ_PUBLIC_URL,
  );
  if (config.SMTP_HOST && localLink) {
    warnings.push(
      `A mail server is configured but RJ_PUBLIC_URL is ${config.RJ_PUBLIC_URL}. Every link in ` +
        'verification and password-reset mail is built from it, so anyone opening one on another ' +
        'machine will not reach this app. Fine while testing from here; set it to the public ' +
        'address before anyone else signs up.',
    );
  }

  if (!config.RJ_TRUST_PROXY && config.RJ_PUBLIC_URL.startsWith('https://')) {
    warnings.push(
      'RJ_PUBLIC_URL is https but RJ_TRUST_PROXY is off. Behind a TLS terminator the session ' +
        'cookie will not be marked Secure, and every per-address rate limit will see the proxy ' +
        "rather than the client. Set RJ_TRUST_PROXY=true if something in front is terminating TLS.",
    );
  }

  return warnings;
}

/** Values safe to log or return from an endpoint. Never anything secret. */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    env: config.NODE_ENV,
    port: config.RJ_SERVICE_PORT,
    compiler: config.RJ_COMPILER_MODE,
    capacity: config.RJ_ACCESS_CAPACITY,
    sessionMinutes: config.RJ_ACCESS_SESSION_MINUTES,
    idleMinutes: config.RJ_ACCESS_IDLE_MINUTES,
    // Whether it is set, never what it is.
    datasheetExtraction: Boolean(config.GEMINI_API_KEY),
    staticAssets: Boolean(config.RJ_STATIC_DIR),
    requireVerifiedEmail: config.RJ_REQUIRE_VERIFIED_EMAIL,
    mail: config.SMTP_HOST ? 'smtp' : 'console',
    signupCredits: config.RJ_SIGNUP_CREDITS,
  };
}
