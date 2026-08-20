/**
 * Capacity control.
 *
 * The clock is injected, because none of this can be tested otherwise: an hour-long session, a
 * twenty minute cooldown and a ninety second heartbeat grace are the whole subject, and waiting
 * for them is not an option. Everything below moves time explicitly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore, CooldownError } from '../src/index.js';

const PASSWORD = 'correct-horse-battery-staple';

describe('access control', () => {
  let store: AccountStore;
  let clock: number;
  /** Small capacity so the queue can be exercised without registering ten accounts each time. */
  const CAPACITY = 3;
  const SESSION_MS = 60 * 60 * 1000;
  const COOLDOWN_MS = 20 * 60 * 1000;
  const IDLE_MS = 2 * 60 * 1000;
  const GRACE_MS = 3 * 60 * 1000;

  beforeEach(() => {
    clock = Date.UTC(2026, 0, 1, 12, 0, 0);
    store = new AccountStore(':memory:', {
      capacity: CAPACITY,
      sessionMs: SESSION_MS,
      cooldownMs: COOLDOWN_MS,
      idleMs: IDLE_MS,
      graceMs: GRACE_MS,
      now: () => clock,
    });
  });

  afterEach(() => store.close());

  /**
   * Move time forward, with the named accounts saying they are still there as they go.
   *
   * A real client heartbeats every half-minute or so, and without doing the same here every test
   * that spans more than the grace period would have its seats reclaimed as abandoned -- correct
   * behaviour, but not what the test was asking about. Anyone left out of `present` is someone
   * who has genuinely walked away.
   */
  const advance = (ms: number, ...present: string[]) => {
    if (present.length === 0 || ms <= 0) {
      clock += ms;
      return;
    }
    const step = Math.min(IDLE_MS, GRACE_MS) / 2;
    let remaining = ms;
    while (remaining > 0) {
      const chunk = Math.min(step, remaining);
      clock += chunk;
      for (const id of present) store.access.heartbeat(id);
      remaining -= chunk;
    }
  };

  /** Register n accounts and return their ids. */
  async function users(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const user = await store.register(`user${i}@example.com`, PASSWORD, `User ${i}`);
      ids.push(user.id);
    }
    return ids;
  }

  it('admits someone straight away when there is room', async () => {
    const [a] = await users(1);
    const status = store.access.request(a!);

    expect(status.state).toBe('active');
    expect(status.position).toBeNull();
    expect(status.expiresAt).toBe(new Date(clock + SESSION_MS).toISOString());
  });

  it('fills every seat before anyone waits', async () => {
    const ids = await users(CAPACITY);
    for (const id of ids) expect(store.access.request(id!).state).toBe('active');
    expect(store.access.status(ids[0]!).waiting).toBe(0);
  });

  it('queues the next arrival', async () => {
    const ids = await users(CAPACITY + 1);
    for (const id of ids.slice(0, CAPACITY)) store.access.request(id!);

    const status = store.access.request(ids[CAPACITY]!);
    expect(status.state).toBe('queued');
    expect(status.position).toBe(1);
    expect(status.waiting).toBe(1);
  });

  it('keeps the queue in the order people joined', async () => {
    const ids = await users(CAPACITY + 3);
    for (const id of ids.slice(0, CAPACITY)) store.access.request(id!);

    for (const [offset, id] of ids.slice(CAPACITY).entries()) {
      advance(1000);
      expect(store.access.request(id!).position).toBe(offset + 1);
    }
  });

  it('keeps that order even when several arrive in the same instant', async () => {
    // The clock does not move here at all, which is the case timestamps cannot separate. Ordering
    // by time and falling back to the user id put these in UUID order: two people were both told
    // they were next, and the seat went to whichever id happened to sort first.
    const ids = (await users(CAPACITY + 3)).map((id) => id!);
    for (const id of ids.slice(0, CAPACITY)) store.access.request(id);

    const waiters = ids.slice(CAPACITY);
    for (const [offset, id] of waiters.entries()) {
      expect(store.access.request(id).position).toBe(offset + 1);
    }
    // And nobody's position changes behind their back once they are in line.
    for (const [offset, id] of waiters.entries()) {
      expect(store.access.status(id).position).toBe(offset + 1);
    }
  });

  it('gives a freed seat to whoever joined first', async () => {
    const ids = (await users(CAPACITY + 2)).map((id) => id!);
    for (const id of ids.slice(0, CAPACITY)) store.access.request(id);
    // Both waiters arrive at the same instant, so only the counter distinguishes them.
    const [first, second] = ids.slice(CAPACITY);
    store.access.request(first!);
    store.access.request(second!);

    store.access.release(ids[0]!);
    expect(store.access.status(first!).state).toBe('active');
    expect(store.access.status(second!).state).toBe('queued');
    expect(store.access.status(second!).position).toBe(1);
  });

  it('asking twice does not lose your place', async () => {
    const ids = await users(CAPACITY + 2);
    for (const id of ids.slice(0, CAPACITY)) store.access.request(id!);
    advance(1000);
    store.access.request(ids[CAPACITY]!);
    advance(1000);
    store.access.request(ids[CAPACITY + 1]!);

    // A double-clicked button must not send the first waiter to the back of the line.
    expect(store.access.request(ids[CAPACITY]!).position).toBe(1);
    expect(store.access.status(ids[CAPACITY + 1]!).position).toBe(2);
  });

  describe('when an hour is up', () => {
    it('ends the session', async () => {
      const [a] = await users(1);
      store.access.request(a!);

      advance(SESSION_MS - 1000, a!);
      expect(store.access.status(a!).state).toBe('active');

      advance(2000, a!);
      expect(store.access.status(a!).state).toBe('cooldown');
    });

    it('starts the cooldown', async () => {
      const [a] = await users(1);
      store.access.request(a!);
      advance(SESSION_MS, a!);

      const status = store.access.status(a!);
      expect(status.cooldownUntil).toBe(new Date(clock + COOLDOWN_MS).toISOString());
    });

    it('refuses to re-queue during the cooldown', async () => {
      const [a] = await users(1);
      store.access.request(a!);
      advance(SESSION_MS, a!);

      expect(() => store.access.request(a!)).toThrow(CooldownError);
      advance(COOLDOWN_MS - 2000);
      expect(() => store.access.request(a!)).toThrow(CooldownError);
    });

    it('lets them back in once it has passed', async () => {
      const [a] = await users(1);
      store.access.request(a!);
      advance(SESSION_MS, a!);
      advance(COOLDOWN_MS);

      expect(store.access.status(a!).state).toBe('idle');
      expect(store.access.request(a!).state).toBe('active');
    });

    it('gives them a fresh full hour, not the remains of the old one', async () => {
      const [a] = await users(1);
      store.access.request(a!);
      advance(SESSION_MS, a!);
      advance(COOLDOWN_MS);

      const status = store.access.request(a!);
      expect(status.expiresAt).toBe(new Date(clock + SESSION_MS).toISOString());
    });

    it('hands the seat to whoever was waiting', async () => {
      const ids = await users(CAPACITY + 1);
      for (const id of ids.slice(0, CAPACITY)) store.access.request(id!);
      advance(1000, ...ids.slice(0, CAPACITY).map((id) => id!));
      const waiter = ids[CAPACITY]!;
      expect(store.access.request(waiter).state).toBe('queued');

      advance(SESSION_MS, ...ids.map((id) => id!));
      expect(store.access.status(waiter).state).toBe('active');
    });

    it('starts the waiter’s hour when they are admitted, not when they joined', async () => {
      // Waiting is not using. Charging the queue against someone's hour would mean a long wait
      // buys a short session.
      const ids = await users(CAPACITY + 1);
      for (const id of ids.slice(0, CAPACITY)) store.access.request(id!);
      const waiter = ids[CAPACITY]!;
      store.access.request(waiter);

      advance(SESSION_MS, ...ids.map((id) => id!));
      const admittedAt = clock;
      const status = store.access.status(waiter);
      expect(status.expiresAt).toBe(new Date(admittedAt + SESSION_MS).toISOString());
    });
  });

  describe('leaving early', () => {
    it('frees the seat immediately', async () => {
      const ids = await users(CAPACITY + 1);
      for (const id of ids.slice(0, CAPACITY)) store.access.request(id!);
      advance(1000, ...ids.slice(0, CAPACITY).map((id) => id!));
      const waiter = ids[CAPACITY]!;
      store.access.request(waiter);

      store.access.release(ids[0]!);
      expect(store.access.status(waiter).state).toBe('active');
    });

    it('still costs a cooldown', async () => {
      // Without this the hour limit is optional: release at fifty-nine minutes, take it straight
      // back, repeat forever.
      const [a] = await users(1);
      store.access.request(a!);
      advance(SESSION_MS - 60 * 1000, a!);

      expect(store.access.release(a!).state).toBe('cooldown');
      expect(() => store.access.request(a!)).toThrow(CooldownError);
    });

    it('costs nothing when only giving up a place in the queue', async () => {
      const ids = await users(CAPACITY + 1);
      for (const id of ids.slice(0, CAPACITY)) store.access.request(id!);
      const waiter = ids[CAPACITY]!;
      store.access.request(waiter);

      expect(store.access.release(waiter).state).toBe('idle');
      // Nothing was used, so nothing is owed: they can rejoin the line at once.
      expect(store.access.request(waiter).state).toBe('queued');
    });
  });

  describe('when someone disappears', () => {
    it('holds the seat across a page reload', async () => {
      const [a] = await users(1);
      store.access.request(a!);

      // A reload takes seconds, not the ninety the grace allows.
      advance(GRACE_MS - 10_000);
      expect(store.access.status(a!).state).toBe('active');
      store.access.heartbeat(a!);
      advance(GRACE_MS - 10_000);
      expect(store.access.status(a!).state).toBe('active');
    });

    it('reclaims a seat nobody is using', async () => {
      const ids = await users(CAPACITY + 1);
      for (const id of ids.slice(0, CAPACITY)) store.access.request(id!);
      advance(1000, ...ids.slice(0, CAPACITY).map((id) => id!));
      const waiter = ids[CAPACITY]!;
      store.access.request(waiter);

      // Everyone holding a seat closes their tab; the waiter keeps saying they are still here.
      advance(GRACE_MS + 1000, waiter);
      expect(store.access.status(waiter).state).toBe('active');
    });

    it('treats an abandoned seat as a finished one', async () => {
      const [a] = await users(1);
      store.access.request(a!);
      advance(GRACE_MS + 1000);

      // Cooldown, not idle. Otherwise closing the tab and reopening it is a free hour, every hour.
      expect(store.access.status(a!).state).toBe('cooldown');
    });

    it('drops someone who stopped waiting, without penalty', async () => {
      const holders = (await users(CAPACITY + 2)).map((id) => id!);
      const ids = holders;
      for (const id of ids.slice(0, CAPACITY)) store.access.request(id);
      advance(1000, ...ids.slice(0, CAPACITY));
      const gone = ids[CAPACITY]!;
      store.access.request(gone);
      advance(1000, ...ids.slice(0, CAPACITY));
      const patient = ids[CAPACITY + 1]!;
      store.access.request(patient);

      // Everyone but `gone` keeps checking in.
      advance(GRACE_MS + 1000, ...ids.slice(0, CAPACITY), patient);

      expect(store.access.status(gone).state).toBe('idle');
      // The line closes up rather than leaving a gap nobody is standing in.
      expect(store.access.status(patient).position).toBe(1);
    });
  });

  it('gates the simulator on holding a seat', async () => {
    const [a] = await users(1);
    expect(store.access.isActive(a!)).toBe(false);
    store.access.request(a!);
    expect(store.access.isActive(a!)).toBe(true);
    advance(SESSION_MS, a!);
    expect(store.access.isActive(a!)).toBe(false);
  });

  it('says how many are waiting, and nothing about how many seats there are', async () => {
    // The queue line needs a length to draw. Seat counts and wait estimates are deliberately not
    // in the payload at all -- not merely hidden by the interface -- so there is nothing to read
    // out of a network tab either.
    const ids = await users(CAPACITY + 1);
    for (const id of ids) store.access.request(id!);

    const status = store.access.status(ids[CAPACITY]!);
    expect(status.waiting).toBe(1);
    expect(status.position).toBe(1);
    expect(status).not.toHaveProperty('capacity');
    expect(status).not.toHaveProperty('active');
    expect(status).not.toHaveProperty('estimatedWaitMs');
  });

  it('defaults to ten seats, an hour, and twenty minutes', () => {
    const defaults = new AccountStore(':memory:');
    try {
      expect(defaults.access.capacity).toBe(10);
      expect(defaults.access.sessionMs).toBe(60 * 60 * 1000);
      expect(defaults.access.cooldownMs).toBe(20 * 60 * 1000);
    } finally {
      defaults.close();
    }
  });
});

/**
 * Migrating a database that already exists.
 *
 * Every test above starts from an empty `:memory:` database, where the CREATE TABLE provides every
 * column and the migration has nothing to do. That is not the case that breaks: the service
 * refused to start against a database made an hour earlier, because the index over a new column
 * was being created before the column was added. These build the older shape by hand.
 */
describe('migration', () => {
  const OLD_SCHEMA = `
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE access (
      user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      state          TEXT NOT NULL,
      queued_at      TEXT,
      started_at     TEXT,
      expires_at     TEXT,
      cooldown_until TEXT,
      last_seen_at   TEXT NOT NULL
    );
  `;

  it('adds the columns a database from before them is missing', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(OLD_SCHEMA);
    // A user for the access row to reference, as any real database would have.
    db.prepare(
      `INSERT INTO users VALUES ('u1', 'a@example.com', 'A', 'x', '2026-01-01T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO access (user_id, state, queued_at, last_seen_at) VALUES ('u1', 'idle', NULL, '2026-01-01T00:00:00.000Z')`,
    ).run();

    const { AccessController } = await import('../src/access.js');
    expect(() => new AccessController(db)).not.toThrow();

    const columns = (db.prepare('PRAGMA table_info(access)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const added of ['queue_seq', 'last_active_at', 'carry_ms', 'last_reason']) {
      expect(columns, added).toContain(added);
    }
    // And the row that was already there survives.
    expect(db.prepare('SELECT COUNT(*) AS n FROM access').get()).toEqual({ n: 1 });
    db.close();
  });

  it('is safe to run twice', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(OLD_SCHEMA);

    const { AccessController } = await import('../src/access.js');
    new AccessController(db);
    expect(() => new AccessController(db)).not.toThrow();
    db.close();
  });
});
