/**
 * Rate limiting for the endpoints worth attacking.
 *
 * In-memory and per-process, which is right for a tool that runs on one machine and wrong for a
 * cluster -- noted here rather than pretended otherwise. Swapping the map for Redis is the only
 * change needed if this is ever deployed behind more than one instance.
 *
 * Keyed on both address and account, because the two attacks are different: a burst from one
 * client is throttled by the first, and a slow distributed guess at one account by the second.
 */

interface Bucket {
  count: number;
  /** When the window resets. */
  resetAt: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Seconds until the caller may retry. */
  readonly retryAfter: number;
  readonly remaining: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): RateLimitResult {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return { allowed: true, retryAfter: 0, remaining: this.limit - 1 };
    }

    bucket.count += 1;
    if (bucket.count > this.limit) {
      return {
        allowed: false,
        retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
        remaining: 0,
      };
    }
    return { allowed: true, retryAfter: 0, remaining: this.limit - bucket.count };
  }

  /** Forget a key, so a successful login does not count against the next one. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Drop expired buckets.
   *
   * Without this the map grows by one entry per distinct key forever, which for an address-keyed
   * limiter is an unbounded leak an attacker controls.
   */
  private sweep(now: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
