/**
 * Redis: the things that are better off not in the database.
 *
 * Two of them, and both earn their place by being wrong in a specific way today.
 *
 * **Rate limiting** was an in-memory counter. That is not a rate limit once there is more than one
 * instance -- it is N separate rate limits, each allowing the full quota -- and it forgets
 * everything on restart, so a crash loop is a way through it. Counters belong somewhere shared and
 * ephemeral, which is exactly what Redis is.
 *
 * **The compile cache** was a Map capped at 64 entries, per process. A cold AVR compile is about
 * two seconds and the result is content-addressed, so it is worth sharing across instances and
 * worth surviving a deploy. It is also worth losing without consequence, which is why it is here
 * and not in Postgres.
 *
 * Nothing that must survive a Redis restart lives here. Sessions, seats and the queue are all in
 * Postgres, because losing a place in the queue is somebody else's turn and losing a seat is a bug
 * someone has to explain.
 */
import { Redis, type RedisOptions } from 'ioredis';

export interface RedisConfig {
  readonly url: string;
  /** Prefixed so one Redis can serve several environments without them colliding. */
  readonly keyPrefix?: string;
}

export function createRedis(config: RedisConfig): Redis {
  // Built inline rather than as a typed constant: `exactOptionalPropertyTypes` makes a declared
  // `RedisOptions` value incompatible with the constructor's own narrower parameter type.
  const options = {
    keyPrefix: config.keyPrefix ?? 'rj:',
    // Fail a command rather than queue it forever when the server is unreachable: a request that
    // hangs waiting for a rate-limit check is worse than one that is refused.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
    // Capped exponential backoff. Without a cap a long outage ends with reconnect attempts minutes
    // apart, so the service stays broken well after Redis has come back.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    lazyConnect: false,
  } satisfies RedisOptions;

  const client = new Redis(config.url, options);

  // Without a listener a connection error is an unhandled 'error' event, which takes the process
  // down. Redis being briefly unavailable must not do that -- see the fallbacks below.
  client.on('error', (error) => {
    console.error('[redis]', error.message);
  });

  return client;
}

/**
 * Fixed-window rate limiter.
 *
 * The whole check is one Lua script so it is atomic: INCR then EXPIRE as two round trips has a
 * window where a key exists with no expiry, and a client that dies between them leaves a counter
 * that never resets and an account locked out permanently.
 *
 * A fixed window rather than a sliding one, deliberately. Its known weakness is that twice the
 * quota can pass either side of a boundary; the quotas here are set to tolerate that, and the
 * alternative costs a sorted set per subject for a property nobody needs.
 */
const LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { current, ttl }
`;

export interface LimitResult {
  readonly allowed: boolean;
  /** Seconds until the window resets. Zero when allowed. */
  readonly retryAfter: number;
}

export class RedisRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly namespace: string,
  ) {}

  /**
   * Count one attempt.
   *
   * Fails open. A rate limiter that refuses every request when Redis is down converts a cache
   * outage into a total outage, and the thing it protects against -- someone guessing passwords --
   * is far less likely than the operational failure. The refusal is logged so it is visible rather
   * than silent.
   */
  async check(subject: string): Promise<LimitResult> {
    const key = `limit:${this.namespace}:${subject}`;
    try {
      const [count, ttl] = (await this.redis.eval(
        LIMIT_SCRIPT,
        1,
        key,
        String(this.windowMs),
      )) as [number, number];

      if (count <= this.limit) return { allowed: true, retryAfter: 0 };
      return { allowed: false, retryAfter: Math.max(1, Math.ceil(ttl / 1000)) };
    } catch (error) {
      console.error('[redis] rate limit unavailable, allowing request', (error as Error).message);
      return { allowed: true, retryAfter: 0 };
    }
  }

  /** Forget a subject's attempts, so one forgotten password does not cost the rest of the window. */
  async reset(subject: string): Promise<void> {
    try {
      await this.redis.del(`limit:${this.namespace}:${subject}`);
    } catch {
      // The window expires on its own.
    }
  }
}

/**
 * Shared cache for compiled firmware.
 *
 * Keyed by the content hash the compiler already computes, so a hit is exact rather than a guess
 * about whether two sketches are the same. Values are JSON with the ELF base64-encoded; a large
 * sketch is a few hundred kilobytes, which is why there is a ceiling on what is stored at all.
 */
export class CompileCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly maxBytes: number,
  ) {}

  async get<T>(hash: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(`compile:${hash}`);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      // A cache miss and an unreachable cache are the same thing to the caller: compile it.
      return null;
    }
  }

  async set(hash: string, value: unknown): Promise<void> {
    try {
      const raw = JSON.stringify(value);
      // Refusing to store an outsized entry rather than evicting everything else to fit it. One
      // enormous sketch should not empty the cache for every ordinary one.
      if (Buffer.byteLength(raw) > this.maxBytes) return;
      await this.redis.set(`compile:${hash}`, raw, 'EX', this.ttlSeconds);
    } catch {
      // Caching is an optimisation; failing to do it is not an error worth surfacing.
    }
  }
}

/** Whether Redis is answering, for the readiness probe. */
export async function redisHealthy(redis: Redis): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}
