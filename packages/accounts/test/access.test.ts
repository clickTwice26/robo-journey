/**
 * Capacity control.
 *
 * The clock is injected, because none of this can be tested otherwise: an hour-long session, a
 * twenty minute cooldown and a ninety second heartbeat grace are the whole subject, and waiting
 * for them is not an option. Everything below moves time explicitly.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore, CooldownError } from '../src/index.js';
import { createBackends, hasDatabase, type TestBackends } from '../../../test/database.js';

const PASSWORD = 'correct-horse-battery-staple';

const describeWithDb = hasDatabase() ? describe : describe.skip;

describeWithDb('access control', () => {
  let backends: TestBackends;
  let store: AccountStore;
  let clock: number;
  /** Small capacity so the queue can be exercised without registering ten accounts each time. */
  const CAPACITY = 3;
  const SESSION_MS = 60 * 60 * 1000;
  const COOLDOWN_MS = 20 * 60 * 1000;
  const IDLE_MS = 2 * 60 * 1000;
  const GRACE_MS = 3 * 60 * 1000;

  beforeEach(async () => {
    clock = Date.UTC(2026, 0, 1, 12, 0, 0);
    backends = await createBackends('access');
    store = new AccountStore(backends.pool, {
      capacity: CAPACITY,
      sessionMs: SESSION_MS,
      cooldownMs: COOLDOWN_MS,
      idleMs: IDLE_MS,
      graceMs: GRACE_MS,
      // The clock is injected here and only here. In production the database's own clock is used,
      // so instances with drifting system times still agree about whose hour is up.
      now: () => clock,
    });
  });

  afterEach(async () => backends.close());

  /**
   * Move time forward, with the named accounts saying they are still there as they go.
   *
   * A real client heartbeats every half-minute or so, and without doing the same here every test
   * that spans more than the grace period would have its seats reclaimed as abandoned -- correct
   * behaviour, but not what the test was asking about. Anyone left out of `present` is someone
   * who has genuinely walked away.
   */
  const advance = async (ms: number, ...present: string[]) => {
    if (present.length === 0 || ms <= 0) {
      clock += ms;
      return;
    }
    const step = Math.min(IDLE_MS, GRACE_MS) / 2;
    let remaining = ms;
    while (remaining > 0) {
      const chunk = Math.min(step, remaining);
      clock += chunk;
      for (const id of present) await store.access.heartbeat(id);
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
    const status = await store.access.request(a!);

    expect(status.state).toBe('active');
    expect(status.position).toBeNull();
    expect(status.expiresAt).toBe(new Date(clock + SESSION_MS).toISOString());
  });

  it('fills every seat before anyone waits', async () => {
    const ids = await users(CAPACITY);
    for (const id of ids) expect((await store.access.request(id!)).state).toBe('active');
    expect((await store.access.status(ids[0]!)).waiting).toBe(0);
  });

  it('queues the next arrival', async () => {
    const ids = await users(CAPACITY + 1);
    for (const id of ids.slice(0, CAPACITY)) await store.access.request(id!);

    const status = await store.access.request(ids[CAPACITY]!);
    expect(status.state).toBe('queued');
    expect(status.position).toBe(1);
    expect(status.waiting).toBe(1);
  });

  it('keeps the queue in the order people joined', async () => {
    const ids = await users(CAPACITY + 3);
    for (const id of ids.slice(0, CAPACITY)) await store.access.request(id!);

    for (const [offset, id] of ids.slice(CAPACITY).entries()) {
      await advance(1000);
      expect((await store.access.request(id!)).position).toBe(offset + 1);
    }
  });

  it('keeps that order even when several arrive in the same instant', async () => {
    // The clock does not move here at all, which is the case timestamps cannot separate. Ordering
    // by time and falling back to the user id put these in UUID order: two people were both told
    // they were next, and the seat went to whichever id happened to sort first.
    const ids = (await users(CAPACITY + 3)).map((id) => id!);
    for (const id of ids.slice(0, CAPACITY)) await store.access.request(id);

    const waiters = ids.slice(CAPACITY);
    for (const [offset, id] of waiters.entries()) {
      expect((await store.access.request(id)).position).toBe(offset + 1);
    }
    // And nobody's position changes behind their back once they are in line.
    for (const [offset, id] of waiters.entries()) {
      expect((await store.access.status(id)).position).toBe(offset + 1);
    }
  });

  it('gives a freed seat to whoever joined first', async () => {
    const ids = (await users(CAPACITY + 2)).map((id) => id!);
    for (const id of ids.slice(0, CAPACITY)) await store.access.request(id);
    // Both waiters arrive at the same instant, so only the counter distinguishes them.
    const [first, second] = ids.slice(CAPACITY);
    await store.access.request(first!);
    await store.access.request(second!);

    await store.access.release(ids[0]!);
    expect((await store.access.status(first!)).state).toBe('active');
    expect((await store.access.status(second!)).state).toBe('queued');
    expect((await store.access.status(second!)).position).toBe(1);
  });

  it('asking twice does not lose your place', async () => {
    const ids = await users(CAPACITY + 2);
    for (const id of ids.slice(0, CAPACITY)) await store.access.request(id!);
    await advance(1000);
    await store.access.request(ids[CAPACITY]!);
    await advance(1000);
    await store.access.request(ids[CAPACITY + 1]!);

    // A double-clicked button must not send the first waiter to the back of the line.
    expect((await store.access.request(ids[CAPACITY]!)).position).toBe(1);
    expect((await store.access.status(ids[CAPACITY + 1]!)).position).toBe(2);
  });

  describe('when an hour is up', () => {
    it('ends the session', async () => {
      const [a] = await users(1);
      await store.access.request(a!);

      await advance(SESSION_MS - 1000, a!);
      expect((await store.access.status(a!)).state).toBe('active');

      await advance(2000, a!);
      expect((await store.access.status(a!)).state).toBe('cooldown');
    });

    it('starts the cooldown', async () => {
      const [a] = await users(1);
      await store.access.request(a!);
      await advance(SESSION_MS, a!);

      const status = await store.access.status(a!);
      expect(status.cooldownUntil).toBe(new Date(clock + COOLDOWN_MS).toISOString());
    });

    it('refuses to re-queue during the cooldown', async () => {
      const [a] = await users(1);
      await store.access.request(a!);
      await advance(SESSION_MS, a!);

      await expect(store.access.request(a!)).rejects.toThrow(CooldownError);
      await advance(COOLDOWN_MS - 2000);
      await expect(store.access.request(a!)).rejects.toThrow(CooldownError);
    });

    it('lets them back in once it has passed', async () => {
      const [a] = await users(1);
      await store.access.request(a!);
      await advance(SESSION_MS, a!);
      await advance(COOLDOWN_MS);

      expect((await store.access.status(a!)).state).toBe('idle');
      expect((await store.access.request(a!)).state).toBe('active');
    });

    it('gives them a fresh full hour, not the remains of the old one', async () => {
      const [a] = await users(1);
      await store.access.request(a!);
      await advance(SESSION_MS, a!);
      await advance(COOLDOWN_MS);

      const status = await store.access.request(a!);
      expect(status.expiresAt).toBe(new Date(clock + SESSION_MS).toISOString());
    });

    it('hands the seat to whoever was waiting', async () => {
      const ids = await users(CAPACITY + 1);
      for (const id of ids.slice(0, CAPACITY)) await store.access.request(id!);
      await advance(1000, ...ids.slice(0, CAPACITY).map((id) => id!));
      const waiter = ids[CAPACITY]!;
      expect((await store.access.request(waiter)).state).toBe('queued');

      await advance(SESSION_MS, ...ids.map((id) => id!));
      expect((await store.access.status(waiter)).state).toBe('active');
    });

    it('starts the waiter’s hour when they are admitted, not when they joined', async () => {
      // Waiting is not using. Charging the queue against someone's hour would mean a long wait
      // buys a short session.
      const ids = await users(CAPACITY + 1);
      for (const id of ids.slice(0, CAPACITY)) await store.access.request(id!);
      const waiter = ids[CAPACITY]!;
      await store.access.request(waiter);

      await advance(SESSION_MS, ...ids.map((id) => id!));
      const admittedAt = clock;
      const status = await store.access.status(waiter);
      expect(status.expiresAt).toBe(new Date(admittedAt + SESSION_MS).toISOString());
    });
  });

  describe('leaving early', () => {
    it('frees the seat immediately', async () => {
      const ids = await users(CAPACITY + 1);
      for (const id of ids.slice(0, CAPACITY)) await store.access.request(id!);
      await advance(1000, ...ids.slice(0, CAPACITY).map((id) => id!));
      const waiter = ids[CAPACITY]!;
      await store.access.request(waiter);

      await store.access.release(ids[0]!);
      expect((await store.access.status(waiter)).state).toBe('active');
    });

    it('still costs a cooldown', async () => {
      // Without this the hour limit is optional: release at fifty-nine minutes, take it straight
      // back, repeat forever.
      const [a] = await users(1);
      await store.access.request(a!);
      await advance(SESSION_MS - 60 * 1000, a!);

      expect((await store.access.release(a!)).state).toBe('cooldown');
      await expect(store.access.request(a!)).rejects.toThrow(CooldownError);
    });

    it('costs nothing when only giving up a place in the queue', async () => {
      const ids = await users(CAPACITY + 1);
      for (const id of ids.slice(0, CAPACITY)) await store.access.request(id!);
      const waiter = ids[CAPACITY]!;
      await store.access.request(waiter);

      expect((await store.access.release(waiter)).state).toBe('idle');
      // Nothing was used, so nothing is owed: they can rejoin the line at once.
      expect((await store.access.request(waiter)).state).toBe('queued');
    });
  });

  describe('when someone disappears', () => {
    it('holds the seat across a page reload', async () => {
      const [a] = await users(1);
      await store.access.request(a!);

      // A reload takes seconds, not the ninety the grace allows.
      await advance(GRACE_MS - 10_000);
      expect((await store.access.status(a!)).state).toBe('active');
      await store.access.heartbeat(a!);
      await advance(GRACE_MS - 10_000);
      expect((await store.access.status(a!)).state).toBe('active');
    });

    it('reclaims a seat nobody is using', async () => {
      const ids = await users(CAPACITY + 1);
      for (const id of ids.slice(0, CAPACITY)) await store.access.request(id!);
      await advance(1000, ...ids.slice(0, CAPACITY).map((id) => id!));
      const waiter = ids[CAPACITY]!;
      await store.access.request(waiter);

      // Everyone holding a seat closes their tab; the waiter keeps saying they are still here.
      await advance(GRACE_MS + 1000, waiter);
      expect((await store.access.status(waiter)).state).toBe('active');
    });

    it('treats an abandoned seat as a finished one', async () => {
      const [a] = await users(1);
      await store.access.request(a!);
      await advance(GRACE_MS + 1000);

      // Cooldown, not idle. Otherwise closing the tab and reopening it is a free hour, every hour.
      expect((await store.access.status(a!)).state).toBe('cooldown');
    });

    it('drops someone who stopped waiting, without penalty', async () => {
      const holders = (await users(CAPACITY + 2)).map((id) => id!);
      const ids = holders;
      for (const id of ids.slice(0, CAPACITY)) await store.access.request(id);
      await advance(1000, ...ids.slice(0, CAPACITY));
      const gone = ids[CAPACITY]!;
      await store.access.request(gone);
      await advance(1000, ...ids.slice(0, CAPACITY));
      const patient = ids[CAPACITY + 1]!;
      await store.access.request(patient);

      // Everyone but `gone` keeps checking in.
      await advance(GRACE_MS + 1000, ...ids.slice(0, CAPACITY), patient);

      expect((await store.access.status(gone)).state).toBe('idle');
      // The line closes up rather than leaving a gap nobody is standing in.
      expect((await store.access.status(patient)).position).toBe(1);
    });
  });

  it('gates the simulator on holding a seat', async () => {
    const [a] = await users(1);
    expect(await store.access.isActive(a!)).toBe(false);
    await store.access.request(a!);
    expect(await store.access.isActive(a!)).toBe(true);
    await advance(SESSION_MS, a!);
    expect(await store.access.isActive(a!)).toBe(false);
  });

  it('says how many are waiting, and nothing about how many seats there are', async () => {
    // The queue line needs a length to draw. Seat counts and wait estimates are deliberately not
    // in the payload at all -- not merely hidden by the interface -- so there is nothing to read
    // out of a network tab either.
    const ids = await users(CAPACITY + 1);
    for (const id of ids) await store.access.request(id!);

    const status = await store.access.status(ids[CAPACITY]!);
    expect(status.waiting).toBe(1);
    expect(status.position).toBe(1);
    expect(status).not.toHaveProperty('capacity');
    expect(status).not.toHaveProperty('active');
    expect(status).not.toHaveProperty('estimatedWaitMs');
  });

  it('defaults to ten seats, an hour, and twenty minutes', async () => {
    const defaults = new AccountStore(backends.pool);
    expect(defaults.access.capacity).toBe(10);
    expect(defaults.access.sessionMs).toBe(60 * 60 * 1000);
    expect(defaults.access.cooldownMs).toBe(20 * 60 * 1000);
    expect(defaults.access.idleMs).toBe(2 * 60 * 1000);
  });
});
