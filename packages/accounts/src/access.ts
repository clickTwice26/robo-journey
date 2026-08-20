/**
 * Capacity control: who is allowed to use the simulator right now.
 *
 * Distinct from authentication, and deliberately so. A session cookie answers "who are you"; a
 * seat answers "may you use the tool at this moment". Keeping them apart means an hour running out
 * does not throw away the identity -- nobody has to retype a password every hour -- while still
 * ending access completely until the cooldown has passed.
 *
 * The rules:
 *
 *   - A fixed number of people at once. Everyone else waits in line, first come first served.
 *   - A seat lasts one hour from the moment it is taken, not from the moment it was asked for.
 *   - A seat has to be *used*. Two minutes with the tab in the background or nobody touching the
 *     keyboard or mouse and it passes to the next person in line.
 *   - However a seat ends for good -- the hour running out, signing out, closing the tab -- a
 *     cooldown follows before that account can queue again, and how long it is depends on how
 *     many people are waiting.
 *
 * That last part is the whole point of `cooldownFor`. A cooldown exists to stop one person cycling
 * through the same seat forever, and that only matters when somebody else wants it. Holding
 * someone out for twenty minutes while ten seats sit empty and nobody is queuing serves nobody: it
 * is friction with no beneficiary. So the wait is a minute when the place is quiet and grows with
 * the queue, and an outstanding cooldown is shortened as the queue drains -- nobody should be kept
 * out for a crowd that has since gone home.
 *
 * A cooldown of *nothing* is still wrong, which is why the floor is a minute rather than zero:
 * without it whoever just finished retakes the seat in the same instant it frees, and someone
 * arriving a second later never sees it.
 *
 * Being idle is treated differently, and more gently: it sends someone to the back of the queue
 * rather than into a cooldown, because they have not finished, they have simply stopped for a
 * moment. What stops that being a way to dodge the hour limit is that the *remaining* time is
 * carried with them -- coming back from the queue resumes the same hour rather than starting a
 * new one, so idling costs a place in line and nothing is gained by it.
 *
 * There is no background timer. Every request reconciles the whole picture first -- expiring what
 * is over, reclaiming what has been abandoned, clearing finished cooldowns, and admitting from the
 * front of the queue -- so the state is correct when it is read rather than correct on a schedule.
 * A server that has been asleep for a day comes back consistent on its first request.
 *
 * All of it runs inside one transaction holding an advisory lock. That is not belt-and-braces: two
 * service instances reconciling at the same moment would each see nine seats taken and each admit
 * someone into the tenth. The lock is what makes "ten" mean ten no matter how many processes are
 * serving.
 */
import type { Pool, PoolClient } from 'pg';
import { LOCK_ACCESS_RECONCILE, withTransaction } from './db.js';

/** How many people may use the simulator at once. */
export const ACCESS_CAPACITY = 10;
/** How long a seat lasts once taken. */
export const ACCESS_SESSION_MS = 60 * 60 * 1000;
/**
 * The longest an account is ever held out after a seat ends.
 *
 * A ceiling, not a constant. See `cooldownFor`.
 */
export const ACCESS_MAX_COOLDOWN_MS = 20 * 60 * 1000;

/**
 * The shortest.
 *
 * Not zero, because a cooldown of nothing lets whoever just finished retake the seat in the same
 * instant it frees, and someone arriving a second later never sees it. A minute is long enough to
 * be a real window for somebody else and short enough not to feel like a punishment.
 */
export const ACCESS_MIN_COOLDOWN_MS = 60 * 1000;

/**
 * How long someone may hold a seat without using it.
 *
 * "Using it" means the page is in front of them and they have touched the keyboard or moved the
 * mouse. Watching a long simulation counts as idle by this measure, which is why the interface
 * warns well before the two minutes are up rather than letting the seat vanish mid-thought.
 */
export const ACCESS_IDLE_MS = 2 * 60 * 1000;

/**
 * How long a seat or queue place survives with no heartbeat at all.
 *
 * Deliberately longer than the idle timeout, and the ordering is the point. A tab in the
 * background is still alive but has its timers throttled to about once a minute by the browser,
 * so a grace shorter than the idle window would sometimes reclaim it as *gone* -- with the
 * cooldown that carries -- when what actually happened is that someone looked at another tab for
 * two minutes. With this ordering, a page that still exists is always handled by the idle rule,
 * and only a genuinely closed tab reaches this one.
 */
export const ACCESS_GRACE_MS = 3 * 60 * 1000;

/** Where an account stands. */
export type AccessState = 'idle' | 'queued' | 'active' | 'cooldown';

/**
 * What a caller is told about where they stand.
 *
 * Deliberately narrow. It carries a place in line and nothing about how many seats exist, how many
 * are taken, or how long the wait might be -- those are the server's business, and quoting them
 * invites people to work out when to come back rather than waiting to be let in. A wait estimate
 * in particular is a promise that cannot be kept: it moves whenever anyone leaves early or drops
 * out, and being told "at most an hour" and then let in at four minutes is no better than the
 * reverse.
 */
export interface AccessStatus {
  readonly state: AccessState;
  /** Place in line, 1 for next to be admitted. Null unless queued. */
  readonly position: number | null;
  /** How many are waiting in total, so the line can be drawn. */
  readonly waiting: number;
  /** When the current seat ends, ISO. Null unless active. */
  readonly expiresAt: string | null;
  /** When the cooldown ends, ISO. Null unless in cooldown. */
  readonly cooldownUntil: string | null;
  /**
   * Why the last seat ended, when it did not simply run its course.
   *
   * Someone bumped for idleness arrives back at the queue with no idea why unless they are told,
   * and "you were moved to the back of the line because nothing happened for two minutes" is a
   * very different message from "your hour is up".
   */
  readonly lastReason: 'idle' | 'expired' | null;
  /** Milliseconds of the hour still owed, carried across a bump. Null when nothing is owed. */
  readonly carriedMs: number | null;
}

export interface AccessConfig {
  readonly capacity?: number;
  readonly sessionMs?: number;
  /** Ceiling on the cooldown, reached only when the queue is as long as the room is wide. */
  readonly maxCooldownMs?: number;
  /** Floor on the cooldown, applied when nobody is waiting. */
  readonly minCooldownMs?: number;
  readonly idleMs?: number;
  readonly graceMs?: number;
  /**
   * Injectable clock, in milliseconds.
   *
   * Omitted in production, where the database's own clock is used instead: several instances with
   * slightly different system times must not disagree about whose hour is up. Supplied by tests,
   * which cannot wait an hour to find out what happens after one.
   */
  readonly now?: () => number;
}

/** Seats taken and people waiting, which is all the cooldown depends on. */
interface Demand {
  readonly waiting: number;
  readonly free: number;
}

interface AccessRow {
  state: AccessState;
  queue_seq: string | null;
  expires_at: Date | null;
  cooldown_until: Date | null;
  carry_ms: string | null;
  last_reason: 'idle' | 'expired' | null;
}

/** Asking for a seat while still cooling down from the last one. */
export class CooldownError extends Error {
  constructor(
    message: string,
    readonly until: Date,
  ) {
    super(message);
    this.name = 'CooldownError';
  }
}

export class AccessController {
  readonly capacity: number;
  readonly sessionMs: number;
  readonly maxCooldownMs: number;
  readonly minCooldownMs: number;
  readonly idleMs: number;
  readonly graceMs: number;
  private readonly clock: (() => number) | undefined;

  constructor(
    private readonly pool: Pool,
    config: AccessConfig = {},
  ) {
    this.capacity = config.capacity ?? ACCESS_CAPACITY;
    this.sessionMs = config.sessionMs ?? ACCESS_SESSION_MS;
    this.maxCooldownMs = config.maxCooldownMs ?? ACCESS_MAX_COOLDOWN_MS;
    this.minCooldownMs = Math.min(
      config.minCooldownMs ?? ACCESS_MIN_COOLDOWN_MS,
      config.maxCooldownMs ?? ACCESS_MAX_COOLDOWN_MS,
    );
    this.idleMs = config.idleMs ?? ACCESS_IDLE_MS;
    this.graceMs = config.graceMs ?? ACCESS_GRACE_MS;
    this.clock = config.now;
  }

  // --- Public API ---------------------------------------------------------------------------------

  /** Where an account stands, after bringing the whole picture up to date. */
  async status(userId: string): Promise<AccessStatus> {
    return this.inLock(async (client, now) => {
      await this.reconcile(client, now);
      return this.read(client, userId);
    });
  }

  /**
   * Ask for a seat.
   *
   * Idempotent: asking again while queued or active simply reports where you already are, so a
   * double-clicked button cannot cost someone their place in line.
   */
  async request(userId: string): Promise<AccessStatus> {
    return this.inLock(async (client, now) => {
      await this.reconcile(client, now);

      const current = await this.row(client, userId);
      if (current?.state === 'active' || current?.state === 'queued') {
        return this.read(client, userId);
      }
      if (current?.state === 'cooldown' && current.cooldown_until) {
        throw new CooldownError(
          `Your last session ended. You can join the queue again at ${current.cooldown_until.toISOString()}.`,
          current.cooldown_until,
        );
      }

      // Queued rather than active even when there is room, then admitted by the reconcile below.
      // One code path decides who gets a seat, so the capacity check cannot be got right in one
      // place and wrong in the other.
      await client.query(
        `INSERT INTO access (user_id, state, queue_seq, queued_at, last_seen_at, last_active_at)
         VALUES ($1::uuid, 'queued', nextval('access_queue_seq'), $2::timestamptz, $2::timestamptz,
                 $2::timestamptz)
         ON CONFLICT (user_id) DO UPDATE SET
           state = 'queued', queue_seq = nextval('access_queue_seq'), queued_at = $2::timestamptz,
           started_at = NULL, expires_at = NULL, cooldown_until = NULL,
           last_seen_at = $2::timestamptz, last_active_at = $2::timestamptz,
           carry_ms = NULL, last_reason = NULL, cooldown_from = NULL`,
        [userId, now],
      );

      await this.reconcile(client, now);
      return this.read(client, userId);
    });
  }

  /**
   * Say you are still here, and whether anyone is actually at the keyboard.
   *
   * Two different facts, deliberately reported together. `present` false still counts as a
   * heartbeat -- the page exists, so nothing is treated as abandoned -- but it does not count as
   * using the seat, which is what the idle timer measures. A background tab reports exactly that:
   * alive, not in use.
   */
  async heartbeat(userId: string, present = true): Promise<AccessStatus> {
    return this.inLock(async (client, now) => {
      await this.reconcile(client, now);

      await client.query(
        `UPDATE access
            SET last_seen_at = $2::timestamptz,
                last_active_at = CASE WHEN $3::boolean THEN $2::timestamptz ELSE last_active_at END
          WHERE user_id = $1::uuid AND state IN ('active', 'queued')`,
        [userId, now, present],
      );

      // Presence can free a seat -- someone at the front who has gone quiet loses it -- so
      // reconcile again rather than reporting a picture taken before this heartbeat landed.
      await this.reconcile(client, now);
      return this.read(client, userId);
    });
  }

  /**
   * Give up a seat or a place in the queue.
   *
   * Leaving a seat early starts the cooldown, exactly as running out of time does. Anything else
   * would make the hour limit optional -- release at fifty-nine minutes, take it straight back.
   * Leaving the queue carries no penalty: nothing was used.
   */
  async release(userId: string): Promise<AccessStatus> {
    return this.inLock(async (client, now) => {
      await this.reconcile(client, now);
      const current = await this.row(client, userId);

      if (current?.state === 'active') {
        const wait = Math.round(this.cooldownFor(await this.demand(client)));
        await client.query(
          `UPDATE access SET state = 'cooldown', cooldown_from = $2::timestamptz,
             cooldown_until = $2::timestamptz + make_interval(secs => $3::bigint / 1000.0),
             started_at = NULL, expires_at = NULL, queued_at = NULL, queue_seq = NULL,
             carry_ms = NULL, last_reason = 'expired'
           WHERE user_id = $1::uuid`,
          [userId, now, wait],
        );
      } else if (current?.state === 'queued') {
        await client.query(
          `UPDATE access SET state = 'idle', queued_at = NULL, queue_seq = NULL,
             cooldown_until = NULL, carry_ms = NULL WHERE user_id = $1`,
          [userId],
        );
      }

      await this.reconcile(client, now);
      return this.read(client, userId);
    });
  }

  /** True when this account may use the simulator right now. The one check that gates the tool. */
  async isActive(userId: string): Promise<boolean> {
    return (await this.status(userId)).state === 'active';
  }

  /**
   * How long to hold someone out, given how busy the place is.
   *
   * The floor when nothing is contended, rising toward the ceiling as the queue lengthens, and
   * reaching it when as many people are waiting as there are seats. Linear rather than anything
   * cleverer because the number has to be explainable to the person waiting: one more person in
   * front of you is one more increment, and that is the whole of it.
   */
  cooldownFor({ waiting, free }: Demand): number {
    // Nobody waiting and somewhere to sit: there is nothing to protect, so this is only the window
    // that stops the previous holder retaking the seat before anyone else can see it.
    if (waiting === 0 && free > 0) return this.minCooldownMs;

    const perWaiter = (this.maxCooldownMs - this.minCooldownMs) / Math.max(1, this.capacity);
    return Math.min(this.maxCooldownMs, this.minCooldownMs + waiting * perWaiter);
  }

  /** Seats taken and people waiting, in one round trip. */
  private async demand(client: PoolClient): Promise<Demand> {
    const { rows } = await client.query<{ waiting: string; active: string }>(
      `SELECT count(*) FILTER (WHERE state = 'queued') AS waiting,
              count(*) FILTER (WHERE state = 'active') AS active
         FROM access`,
    );
    const waiting = Number(rows[0]!.waiting);
    const active = Number(rows[0]!.active);
    return { waiting, free: Math.max(0, this.capacity - active) };
  }

  // --- Machinery ----------------------------------------------------------------------------------

  /**
   * Run a unit of work with the reconcile lock held and a single agreed idea of "now".
   *
   * The lock and the clock are taken in one round trip. The clock comes from the database rather
   * than from this process precisely because there may be several processes: the hour has to end
   * at the same instant for everyone, and system clocks drift.
   */
  private async inLock<T>(run: (client: PoolClient, now: Date) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ t: Date }>(
        'SELECT pg_advisory_xact_lock($1), now() AS t',
        [LOCK_ACCESS_RECONCILE],
      );
      const now = this.clock ? new Date(this.clock()) : rows[0]!.t;
      return run(client, now);
    });
  }

  /**
   * Bring every row up to date and fill any free seats.
   *
   * Order matters and is not arbitrary. Expiry first, so a seat whose hour is up is not also
   * considered for an idle bump. Then idleness, then cooldowns, and only then admission -- which
   * has to see every seat freed by the steps above, or it would admit against a stale count.
   */
  private async reconcile(client: PoolClient, now: Date): Promise<void> {
    const staleBefore = new Date(now.getTime() - this.graceMs);
    const idleBefore = new Date(now.getTime() - this.idleMs);

    // How contended things were as this pass began, which is what anyone losing a seat in it is
    // held out by.
    const entering = this.cooldownFor(await this.demand(client));

    // A seat whose hour is up, and a seat whose owner has vanished entirely, end the same way.
    await client.query(
      `UPDATE access SET state = 'cooldown', cooldown_from = $1::timestamptz,
         cooldown_until = $1::timestamptz + make_interval(secs => $2::bigint / 1000.0),
         started_at = NULL, expires_at = NULL, queued_at = NULL, queue_seq = NULL, carry_ms = NULL,
         last_reason = 'expired'
       WHERE state = 'active' AND (expires_at <= $1::timestamptz OR last_seen_at < $3::timestamptz)`,
      [now, Math.round(entering), staleBefore],
    );

    // A seat nobody is using goes to whoever is next, and its holder goes to the back of the line
    // with the rest of their hour intact. Rejoining rather than cooling down, because they have
    // not had their turn -- and carrying the remainder, because otherwise going quiet for two
    // minutes would be a way to start the hour over. `last_active_at` is stamped forward so being
    // re-admitted does not trip the same stale timestamp immediately.
    await client.query(
      `UPDATE access
          SET state = 'queued',
              queue_seq = nextval('access_queue_seq'),
              queued_at = $1::timestamptz,
              started_at = NULL,
              carry_ms = GREATEST(0, EXTRACT(EPOCH FROM (expires_at - $1::timestamptz)) * 1000)::BIGINT,
              expires_at = NULL,
              last_reason = 'idle',
              last_active_at = $1::timestamptz
        WHERE state = 'active' AND last_active_at IS NOT NULL AND last_active_at < $2::timestamptz
          AND expires_at > $1::timestamptz`,
      [now, idleBefore],
    );

    // Someone who stopped waiting simply leaves the line. No cooldown: they never got a seat, and
    // penalising them for giving up would be punishing the wrong thing.
    await client.query(
      `UPDATE access SET state = 'idle', queued_at = NULL, queue_seq = NULL
        WHERE state = 'queued' AND last_seen_at < $1::timestamptz`,
      [staleBefore],
    );

    // Recalculated against how busy it is *now*, and only ever shortened. Someone who finished
    // when twelve people were queuing should not still be waiting twenty minutes once the queue
    // has emptied -- but nor should a cooldown grow because the place filled up after they left,
    // which is what LEAST guarantees.
    const current = Math.round(this.cooldownFor(await this.demand(client)));
    await client.query(
      `UPDATE access
          SET cooldown_until = LEAST(
                cooldown_until,
                cooldown_from + make_interval(secs => $1::bigint / 1000.0)
              )
        WHERE state = 'cooldown' AND cooldown_from IS NOT NULL`,
      [current],
    );

    await client.query(
      `UPDATE access SET state = 'idle', cooldown_until = NULL, cooldown_from = NULL,
         carry_ms = NULL
        WHERE state = 'cooldown' AND cooldown_until <= $1::timestamptz`,
      [now],
    );

    // Fill whatever is free, longest wait first. A full hour for a new turn; whatever was left of
    // the old one for someone coming back from an idle bump.
    await client.query(
      `WITH free AS (
         SELECT GREATEST(0, $1::int - (SELECT COUNT(*) FROM access WHERE state = 'active')) AS n
       ),
       next_up AS (
         SELECT user_id FROM access
          WHERE state = 'queued'
          ORDER BY queue_seq
          LIMIT (SELECT n FROM free)
       )
       UPDATE access SET
         state = 'active',
         started_at = $2::timestamptz,
         expires_at = $2::timestamptz
           + make_interval(secs => COALESCE(NULLIF(carry_ms, 0), $3::bigint) / 1000.0),
         queued_at = NULL,
         queue_seq = NULL,
         carry_ms = NULL,
         last_seen_at = $2::timestamptz,
         last_active_at = $2::timestamptz
       WHERE user_id IN (SELECT user_id FROM next_up)`,
      [this.capacity, now, this.sessionMs],
    );
  }

  private async row(client: PoolClient, userId: string): Promise<AccessRow | undefined> {
    const { rows } = await client.query<AccessRow>(
      `SELECT state, queue_seq, expires_at, cooldown_until, carry_ms, last_reason
         FROM access WHERE user_id = $1`,
      [userId],
    );
    return rows[0];
  }

  /** Read a user's standing. Always called with the lock held, just after a reconcile. */
  private async read(client: PoolClient, userId: string): Promise<AccessStatus> {
    const [row, waitingRow] = await Promise.all([
      this.row(client, userId),
      client
        .query<{ n: string }>(`SELECT COUNT(*) AS n FROM access WHERE state = 'queued'`)
        .then((result) => result.rows[0]!),
    ]);

    const base = {
      waiting: Number(waitingRow.n),
      lastReason: row?.last_reason ?? null,
      carriedMs: row?.carry_ms !== null && row?.carry_ms !== undefined ? Number(row.carry_ms) : null,
    };

    if (!row || row.state === 'idle') {
      return { ...base, state: 'idle', position: null, expiresAt: null, cooldownUntil: null };
    }
    if (row.state === 'active') {
      return {
        ...base,
        state: 'active',
        position: null,
        expiresAt: row.expires_at?.toISOString() ?? null,
        cooldownUntil: null,
      };
    }
    if (row.state === 'cooldown') {
      return {
        ...base,
        state: 'cooldown',
        position: null,
        expiresAt: null,
        cooldownUntil: row.cooldown_until?.toISOString() ?? null,
      };
    }

    const { rows } = await client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM access WHERE state = 'queued' AND queue_seq < $1`,
      [row.queue_seq],
    );
    return {
      ...base,
      state: 'queued',
      position: Number(rows[0]!.n) + 1,
      expiresAt: null,
      cooldownUntil: null,
    };
  }
}
