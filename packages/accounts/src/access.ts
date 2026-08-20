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
 *   - Ten people at once. Everyone else waits in line, first come first served.
 *   - A seat lasts one hour from the moment it is taken, not from the moment it was asked for.
 *   - A seat has to be *used*. Two minutes with the tab in the background or nobody touching the
 *     keyboard or mouse and it passes to the next person in line.
 *   - However a seat ends for good -- the hour running out, signing out, closing the tab -- a
 *     twenty minute cooldown follows before that account can queue again.
 *
 * The cooldown is what makes the scheme hold. Without it, anyone at fifty-nine minutes could
 * release their seat and immediately take it again for another hour, and the limit would mean
 * nothing. It does mean leaving early costs the same as being timed out, which is worth saying
 * plainly in the interface rather than surprising people with.
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
 */
import { DatabaseSync } from 'node:sqlite';

/** How many people may use the simulator at once. */
export const ACCESS_CAPACITY = 10;
/** How long a seat lasts once taken. */
export const ACCESS_SESSION_MS = 60 * 60 * 1000;
/** How long an account must wait after a seat ends before it can queue again. */
export const ACCESS_COOLDOWN_MS = 20 * 60 * 1000;
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
export type AccessState =
  /** Signed in, holding nothing, free to ask for a seat. */
  | 'idle'
  /** Waiting for a seat. */
  | 'queued'
  /** Holding a seat; the simulator is usable. */
  | 'active'
  /** A seat has ended recently; must wait before queueing again. */
  | 'cooldown';

export interface AccessStatus {
  readonly state: AccessState;
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
  /** Place in line, 1 for next to be admitted. Null unless queued. */
  readonly position: number | null;
  /** How many are waiting in total. */
  readonly waiting: number;
  /** How many seats are taken. */
  readonly active: number;
  readonly capacity: number;
  /** When the current seat ends, ISO. Null unless active. */
  readonly expiresAt: string | null;
  /** When the cooldown ends, ISO. Null unless in cooldown. */
  readonly cooldownUntil: string | null;
  /**
   * Longest this account should have to wait, milliseconds. Null unless queued.
   *
   * An upper bound rather than a guess: it assumes every seat ahead runs its full hour and nobody
   * leaves early or drops out, both of which only make the real wait shorter. A number that can
   * only improve is worth showing; one that might turn out to be optimistic is not.
   */
  readonly estimatedWaitMs: number | null;
}

export interface AccessConfig {
  readonly capacity?: number;
  readonly sessionMs?: number;
  readonly cooldownMs?: number;
  readonly idleMs?: number;
  readonly graceMs?: number;
  /** Injectable clock. Testing an hour-long session any other way means waiting an hour. */
  readonly now?: () => number;
}

interface AccessRow {
  user_id: string;
  state: AccessState;
  queue_seq: number | null;
  queued_at: string | null;
  started_at: string | null;
  expires_at: string | null;
  cooldown_until: string | null;
  last_seen_at: string;
  /** Last moment the client reported a visible tab and real input. */
  last_active_at: string;
  /** Milliseconds of the hour still owed after an idle bump. */
  carry_ms: number | null;
  last_reason: 'idle' | 'expired' | null;
}

/** Why a request for a seat did not produce one. */
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
  readonly cooldownMs: number;
  readonly idleMs: number;
  readonly graceMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: DatabaseSync,
    config: AccessConfig = {},
  ) {
    this.capacity = config.capacity ?? ACCESS_CAPACITY;
    this.sessionMs = config.sessionMs ?? ACCESS_SESSION_MS;
    this.cooldownMs = config.cooldownMs ?? ACCESS_COOLDOWN_MS;
    this.idleMs = config.idleMs ?? ACCESS_IDLE_MS;
    this.graceMs = config.graceMs ?? ACCESS_GRACE_MS;
    this.now = config.now ?? Date.now;
    this.migrate();
  }

  /**
   * Create or update the table.
   *
   * The order here is not cosmetic and was got wrong once: the index covers `queue_seq`, so it has
   * to be created *after* the column exists. On a fresh database the CREATE TABLE provides it and
   * either order works, which is exactly why every test passed while the service refused to start
   * against a database made an hour earlier.
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS access (
        user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        state          TEXT NOT NULL,
        queue_seq      INTEGER,
        queued_at      TEXT,
        started_at     TEXT,
        expires_at     TEXT,
        cooldown_until TEXT,
        last_seen_at   TEXT NOT NULL,
        last_active_at TEXT,
        carry_ms       INTEGER,
        last_reason    TEXT
      );
    `);

    // Columns added after the table first shipped. `queue_seq` replaced ordering by timestamp with
    // the user id as a tiebreak, which was not first come first served: two people joining in the
    // same millisecond were ordered by a random UUID, and one who had been told they were next
    // could be silently moved. A counter has no ties.
    const columns = this.db.prepare('PRAGMA table_info(access)').all() as { name: string }[];
    const has = (name: string) => columns.some((column) => column.name === name);
    if (!has('queue_seq')) this.db.exec('ALTER TABLE access ADD COLUMN queue_seq INTEGER');
    if (!has('last_active_at')) this.db.exec('ALTER TABLE access ADD COLUMN last_active_at TEXT');
    if (!has('carry_ms')) this.db.exec('ALTER TABLE access ADD COLUMN carry_ms INTEGER');
    if (!has('last_reason')) this.db.exec('ALTER TABLE access ADD COLUMN last_reason TEXT');

    this.db.exec('CREATE INDEX IF NOT EXISTS access_queue ON access(state, queue_seq)');
  }

  // --- Reading ------------------------------------------------------------------------------------

  /** Where an account stands, after bringing the whole picture up to date. */
  status(userId: string): AccessStatus {
    this.reconcile();
    return this.read(userId);
  }

  /** Seats taken and people waiting, for the sign-in screen. Needs no account. */
  occupancy(): { active: number; waiting: number; capacity: number } {
    this.reconcile();
    return {
      active: this.countByState('active'),
      waiting: this.countByState('queued'),
      capacity: this.capacity,
    };
  }

  // --- Acting -------------------------------------------------------------------------------------

  /**
   * Ask for a seat.
   *
   * Idempotent: asking again while queued or active simply reports where you already are, so a
   * double-clicked button cannot cost someone their place in line.
   */
  request(userId: string): AccessStatus {
    this.reconcile();
    const current = this.row(userId);

    if (current?.state === 'active' || current?.state === 'queued') return this.read(userId);

    if (current?.state === 'cooldown' && current.cooldown_until) {
      const until = new Date(current.cooldown_until);
      throw new CooldownError(
        `Your last session ended. You can join the queue again at ${until.toISOString()}.`,
        until,
      );
    }

    const now = this.now();
    const stamp = new Date(now).toISOString();

    // Queued rather than active even when there is room, then admitted by the reconcile pass
    // below. One code path decides who gets a seat, so the capacity check cannot be got right in
    // one place and wrong in the other.
    const seq = this.nextSequence();
    this.db
      .prepare(
        `INSERT INTO access (user_id, state, queue_seq, queued_at, started_at, expires_at,
                             cooldown_until, last_seen_at, last_active_at, carry_ms, last_reason)
         VALUES (?, 'queued', ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL)
         ON CONFLICT(user_id) DO UPDATE SET
           state = 'queued', queue_seq = excluded.queue_seq, queued_at = excluded.queued_at,
           started_at = NULL, expires_at = NULL, cooldown_until = NULL,
           last_seen_at = excluded.last_seen_at, last_active_at = excluded.last_active_at,
           carry_ms = NULL, last_reason = NULL`,
      )
      .run(userId, seq, stamp, stamp, stamp);

    this.reconcile();
    return this.read(userId);
  }

  /**
   * Say you are still here, and whether anyone is actually at the keyboard.
   *
   * Two different facts, deliberately reported together. `present` false still counts as a
   * heartbeat -- the page exists, so nothing is treated as abandoned -- but it does not count as
   * using the seat, which is what the idle timer measures. A background tab reports exactly that:
   * alive, not in use.
   */
  heartbeat(userId: string, present = true): AccessStatus {
    this.reconcile();
    const stamp = new Date(this.now()).toISOString();

    this.db
      .prepare(`UPDATE access SET last_seen_at = ? WHERE user_id = ? AND state IN ('active','queued')`)
      .run(stamp, userId);
    if (present) {
      this.db
        .prepare(`UPDATE access SET last_active_at = ? WHERE user_id = ? AND state IN ('active','queued')`)
        .run(stamp, userId);
    }

    // Presence can free a seat -- someone at the front of the queue who has gone quiet loses it --
    // so reconcile again rather than reporting a picture taken before this heartbeat landed.
    this.reconcile();
    return this.read(userId);
  }

  /**
   * Give up a seat or a place in the queue.
   *
   * Leaving a seat early starts the cooldown, exactly as running out of time does. Anything else
   * would make the hour limit optional -- release at fifty-nine minutes, take it straight back.
   * Leaving the queue carries no penalty: nothing was used.
   */
  release(userId: string): AccessStatus {
    this.reconcile();
    const current = this.row(userId);

    if (current?.state === 'active') this.beginCooldown(userId);
    else if (current?.state === 'queued') this.setIdle(userId);

    this.reconcile();
    return this.read(userId);
  }

  /** True when this account may use the simulator right now. The one check that gates the tool. */
  isActive(userId: string): boolean {
    return this.status(userId).state === 'active';
  }

  // --- Reconciliation -----------------------------------------------------------------------------

  /**
   * Bring every row up to date and fill any free seats.
   *
   * Wrapped in an immediate transaction so two requests arriving together cannot both be handed
   * the last seat. Within a single Node process the synchronous driver already serialises this;
   * the transaction is what makes it hold if the database is ever opened by a second process.
   */
  private reconcile(): void {
    const now = this.now();
    const stamp = new Date(now).toISOString();
    const staleBefore = new Date(now - this.graceMs).toISOString();
    const idleBefore = new Date(now - this.idleMs).toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // A seat whose hour is up, and a seat whose owner has vanished entirely, end the same way.
      this.db
        .prepare(
          `UPDATE access SET state = 'cooldown', cooldown_until = ?, started_at = NULL,
             expires_at = NULL, queued_at = NULL, queue_seq = NULL, carry_ms = NULL,
             last_reason = 'expired'
           WHERE state = 'active' AND (expires_at <= ? OR last_seen_at < ?)`,
        )
        .run(new Date(now + this.cooldownMs).toISOString(), stamp, staleBefore);

      // A seat nobody is using goes to whoever is next, and its holder goes to the back of the
      // line with the rest of their hour intact. Rejoining rather than cooling down, because they
      // have not had their turn -- and carrying the remainder, because otherwise going quiet for
      // two minutes would be a way to start the hour over.
      const idle = this.db
        .prepare(
          `SELECT user_id, expires_at FROM access
           WHERE state = 'active' AND last_active_at IS NOT NULL AND last_active_at < ?`,
        )
        .all(idleBefore) as { user_id: string; expires_at: string }[];

      for (const seat of idle) {
        const remaining = new Date(seat.expires_at).getTime() - now;
        if (remaining <= 0) continue; // Already handled as expired above.

        this.db
          .prepare(
            `UPDATE access SET state = 'queued', queue_seq = ?, queued_at = ?, started_at = NULL,
               expires_at = NULL, carry_ms = ?, last_reason = 'idle', last_active_at = ?
             WHERE user_id = ?`,
          )
          // Presence is stamped forward so the moment they are re-admitted they are not instantly
          // bumped again by the same stale timestamp.
          .run(this.nextSequence(), stamp, remaining, stamp, seat.user_id);
      }

      // Someone who stopped waiting simply leaves the line. No cooldown: they never got a seat,
      // and penalising them for giving up would be punishing the wrong thing.
      this.db
        .prepare(
          `UPDATE access SET state = 'idle', queued_at = NULL, queue_seq = NULL
           WHERE state = 'queued' AND last_seen_at < ?`,
        )
        .run(staleBefore);

      this.db
        .prepare(`UPDATE access SET state = 'idle', cooldown_until = NULL WHERE state = 'cooldown' AND cooldown_until <= ?`)
        .run(stamp);

      // Fill whatever is free, longest wait first.
      let free = this.capacity - this.countByState('active');
      if (free > 0) {
        const next = this.db
          .prepare(`SELECT user_id FROM access WHERE state = 'queued' ORDER BY queue_seq LIMIT ?`)
          .all(free) as { user_id: string }[];

        for (const { user_id } of next) {
          // A full hour for a new turn; whatever was left of the old one for someone coming back
          // from an idle bump. That is what makes going quiet cost a place in line and nothing
          // else -- and nothing gained either.
          const carried = this.db
            .prepare('SELECT carry_ms FROM access WHERE user_id = ?')
            .get(user_id) as { carry_ms: number | null };
          const span = carried.carry_ms !== null && carried.carry_ms > 0
            ? Number(carried.carry_ms)
            : this.sessionMs;

          this.db
            .prepare(
              `UPDATE access SET state = 'active', started_at = ?, expires_at = ?, queued_at = NULL,
                 queue_seq = NULL, carry_ms = NULL, last_seen_at = ?, last_active_at = ?
               WHERE user_id = ?`,
            )
            // The hour starts now, not when they joined the queue: waiting is not using.
            .run(stamp, new Date(now + span).toISOString(), stamp, stamp, user_id);
          free--;
        }
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private beginCooldown(userId: string): void {
    this.db
      .prepare(
        `UPDATE access SET state = 'cooldown', cooldown_until = ?, started_at = NULL,
           expires_at = NULL, queued_at = NULL, queue_seq = NULL, carry_ms = NULL,
           last_reason = 'expired' WHERE user_id = ?`,
      )
      .run(new Date(this.now() + this.cooldownMs).toISOString(), userId);
  }

  private setIdle(userId: string): void {
    this.db
      .prepare(
        `UPDATE access SET state = 'idle', queued_at = NULL, queue_seq = NULL,
           cooldown_until = NULL, carry_ms = NULL WHERE user_id = ?`,
      )
      .run(userId);
  }

  /**
   * The next place in line.
   *
   * A counter rather than a timestamp, because arrival order has to be total. Two people joining
   * in the same millisecond are indistinguishable by time, and falling back to a random user id
   * puts them in an arbitrary order -- one of them having already been told they were next.
   */
  private nextSequence(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(queue_seq), 0) AS n FROM access').get() as {
      n: number;
    };
    return Number(row.n) + 1;
  }

  // --- Queries ------------------------------------------------------------------------------------

  private row(userId: string): AccessRow | undefined {
    return this.db.prepare('SELECT * FROM access WHERE user_id = ?').get(userId) as
      | AccessRow
      | undefined;
  }

  private countByState(state: AccessState): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM access WHERE state = ?')
      .get(state) as { n: number };
    return Number(row.n);
  }

  /** Read a user's standing without reconciling. Always called just after a reconcile. */
  private read(userId: string): AccessStatus {
    const row = this.row(userId);
    const active = this.countByState('active');
    const waiting = this.countByState('queued');
    const base = {
      active,
      waiting,
      capacity: this.capacity,
      lastReason: row?.last_reason ?? null,
      carriedMs: row?.carry_ms ?? null,
    };

    if (!row || row.state === 'idle') {
      return { ...base, state: 'idle', position: null, expiresAt: null, cooldownUntil: null, estimatedWaitMs: null };
    }

    if (row.state === 'active') {
      return {
        ...base,
        state: 'active',
        position: null,
        expiresAt: row.expires_at,
        cooldownUntil: null,
        estimatedWaitMs: null,
      };
    }

    if (row.state === 'cooldown') {
      return {
        ...base,
        state: 'cooldown',
        position: null,
        expiresAt: null,
        cooldownUntil: row.cooldown_until,
        estimatedWaitMs: null,
      };
    }

    const ahead = this.db
      .prepare(`SELECT COUNT(*) AS n FROM access WHERE state = 'queued' AND queue_seq < ?`)
      .get(row.queue_seq) as { n: number };
    const position = Number(ahead.n) + 1;

    return {
      ...base,
      state: 'queued',
      position,
      expiresAt: null,
      cooldownUntil: null,
      estimatedWaitMs: this.waitEstimate(position),
    };
  }

  /**
   * Upper bound on the wait for a given position.
   *
   * Seats free in the order they expire, so the person at position N is admitted no later than the
   * Nth soonest expiry. Only an upper bound: anyone leaving early or dropping out of the queue
   * ahead brings it forward.
   */
  private waitEstimate(position: number): number | null {
    const expiries = (
      this.db
        .prepare(`SELECT expires_at FROM access WHERE state = 'active' ORDER BY expires_at LIMIT ?`)
        .all(position) as { expires_at: string }[]
    ).map((r) => new Date(r.expires_at).getTime());

    // Fewer seats taken than places ahead means one is free already; the next pass admits them.
    if (expiries.length < position) return 0;
    return Math.max(0, expiries[position - 1]! - this.now());
  }
}
