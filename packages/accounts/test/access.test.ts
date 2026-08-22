/**
 * Capacity control.
 *
 * The clock is injected, because none of this can be tested otherwise: an hour-long session and a
 * ninety second heartbeat grace are the whole subject, and waiting for them is not an option.
 * Everything below moves time explicitly.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore } from '../src/index.js';
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
  const IDLE_MS = 2 * 60 * 1000;
  const GRACE_MS = 3 * 60 * 1000;

  beforeEach(async () => {
    clock = Date.UTC(2026, 0, 1, 12, 0, 0);
    backends = await createBackends('access');
    store = new AccountStore(backends.pool, {
      capacity: CAPACITY,
      sessionMs: SESSION_MS,
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
      expect((await store.access.status(a!)).state).toBe('idle');
    });

    it('says why, so the gate is not a mystery', async () => {
      const [a] = await users(1);
      await store.access.request(a!);
      await advance(SESSION_MS, a!);
      expect((await store.access.status(a!)).lastReason).toBe('expired');
    });

    it('lets them straight back in when nobody else wants the seat', async () => {
      // The whole point of having no holding period: friction with no beneficiary is just friction.
      const [a] = await users(1);
      await store.access.request(a!);
      await advance(SESSION_MS, a!);

      expect((await store.access.status(a!)).state).toBe('idle');
      expect((await store.access.request(a!)).state).toBe('active');
    });

    it('puts them behind anyone already waiting, which is what keeps it fair', async () => {
      // Three seats, all taken, with two more waiting. The first holder's hour ends and they ask
      // again immediately -- they must not get the seat they just gave up.
      const ids = await users(5);
      for (const id of ids.slice(0, 3)) await store.access.request(id);
      await store.access.request(ids[3]!);
      await store.access.request(ids[4]!);

      await advance(SESSION_MS, ...ids);
      // Every seat expired together and the two waiting were admitted first.
      expect((await store.access.status(ids[3]!)).state).toBe('active');
      expect((await store.access.status(ids[4]!)).state).toBe('active');

      const again = await store.access.request(ids[0]!);
      expect(again.state).toBe('active');
      expect((await store.access.status(ids[1]!)).state).toBe('idle');
    });

    it('gives them a fresh full hour, not the remains of the old one', async () => {
      const [a] = await users(1);
      await store.access.request(a!);
      await advance(SESSION_MS, a!);

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

    it('gives the seat up, and lets it be taken again when nobody else wants it', async () => {
      const [a] = await users(1);
      await store.access.request(a!);
      await advance(SESSION_MS - 60 * 1000, a!);

      expect((await store.access.release(a!)).state).toBe('idle');
      expect((await store.access.request(a!)).state).toBe('active');
    });

    it('goes behind the queue on the way back, so releasing cannot jump it', async () => {
      // This is what stops release-and-retake being a way around the hour: the seat you gave up
      // goes to whoever was waiting, and you rejoin at the back.
      const ids = await users(CAPACITY + 1);
      for (const id of ids.slice(0, CAPACITY)) await store.access.request(id!);
      const waiter = ids[CAPACITY]!;
      await store.access.request(waiter);

      await store.access.release(ids[0]!);
      expect((await store.access.status(waiter)).state).toBe('active');

      // Every seat is full again, so asking now means queuing rather than walking back in.
      expect((await store.access.request(ids[0]!)).state).toBe('queued');
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

      // The seat is reclaimed for whoever wants it next. Reopening the tab and asking again is
      // fine when nothing is contended, and goes to the back of the queue when it is.
      expect((await store.access.status(a!)).state).toBe('idle');
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

  describe('a seat has to be used', () => {
    /**
     * Move time forward with `idle` accounts leaving the page open but untouched, and `present`
     * accounts working normally.
     *
     * Both lists matter. Anyone left out of either sends no heartbeat at all, which is a closed
     * tab rather than an idle one -- a different rule with a different outcome, and an easy way to
     * write a test that passes for the wrong reason.
     */
    const idleAway = async (ms: number, idle: string[], present: string[] = []) => {
      const step = IDLE_MS / 4;
      let remaining = ms;
      while (remaining > 0) {
        const chunk = Math.min(step, remaining);
        clock += chunk;
        for (const id of idle) await store.access.heartbeat(id, false);
        for (const id of present) await store.access.heartbeat(id, true);
        remaining -= chunk;
      }
    };

    it('passes it on when nobody is at the keyboard', async () => {
      const ids = (await users(CAPACITY + 1)).map((id) => id!);
      for (const id of ids.slice(0, CAPACITY)) await store.access.request(id);
      const waiter = ids[CAPACITY]!;
      await store.access.request(waiter);

      // Everyone with a seat leaves the tab open and walks away; the waiter is at the keyboard.
      await idleAway(IDLE_MS + 1000, ids.slice(0, CAPACITY), [waiter]);

      expect((await store.access.status(waiter)).state).toBe('active');
    });

    it('sends them to the back of the line rather than out altogether', async () => {
      // They have not had their turn, so ending it would be punishing the wrong thing. Losing
      // their place is the whole penalty.
      const ids = (await users(CAPACITY + 1)).map((id) => id!);
      for (const id of ids.slice(0, CAPACITY)) await store.access.request(id);
      const waiter = ids[CAPACITY]!;
      await store.access.request(waiter);

      await idleAway(IDLE_MS + 1000, [ids[0]!], [...ids.slice(1, CAPACITY), waiter]);

      const status = await store.access.status(ids[0]!);
      expect(status.state).toBe('queued');
      expect(status.lastReason).toBe('idle');
    });

    it('leaves them where they are when nobody else wants the seat', async () => {
      // Bumping someone out of a seat that would then sit empty helps no one. They are put back in
      // the queue and admitted again immediately, which from their side is simply not interrupted.
      const [a] = (await users(1)).map((id) => id!);
      await store.access.request(a!);
      await idleAway(IDLE_MS + 1000, [a!]);
      expect((await store.access.status(a!)).state).toBe('active');
    });

    it('still spends the hour while idling through it', async () => {
      // Being re-admitted must not refill the clock, or leaving a tab open and untouched would be
      // an unlimited session.
      const [a] = (await users(1)).map((id) => id!);
      const start = await store.access.request(a!);
      const firstExpiry = new Date(start.expiresAt!).getTime();

      await idleAway(10 * 60 * 1000, [a!]);
      const after = await store.access.status(a!);
      expect(after.state).toBe('active');
      // Within a couple of minutes of the original deadline, not ten minutes past it.
      expect(new Date(after.expiresAt!).getTime()).toBeLessThan(firstExpiry + IDLE_MS);
    });

    it('carries the rest of the hour with them', async () => {
      // Otherwise going quiet for two minutes would be a way to start the hour over, which would
      // make the whole limit optional.
      const ids = (await users(CAPACITY + 1)).map((id) => id!);
      for (const id of ids.slice(0, CAPACITY)) await store.access.request(id);
      const waiter = ids[CAPACITY]!;
      await store.access.request(waiter);

      // Half an hour of work, then a walk away while the waiter stays at the keyboard.
      await advance(30 * 60 * 1000, ...ids.slice(0, CAPACITY), waiter);
      await idleAway(IDLE_MS + 1000, [ids[0]!], [...ids.slice(1, CAPACITY), waiter]);

      const bumped = await store.access.status(ids[0]!);
      expect(bumped.state).toBe('queued');
      expect(bumped.carriedMs).toBeGreaterThan(27 * 60 * 1000);
      expect(bumped.carriedMs).toBeLessThan(30 * 60 * 1000);

      // Back at the front and admitted: the remaining half hour, not a fresh one.
      await store.access.release(ids[1]!);
      const back = await store.access.heartbeat(ids[0]!);
      expect(back.state).toBe('active');
      const left = new Date(back.expiresAt!).getTime() - clock;
      expect(left).toBeLessThan(30 * 60 * 1000);
      expect(left).toBeGreaterThan(27 * 60 * 1000);
    });

    it('counts a background tab as not using it', async () => {
      // The page is alive and heartbeating, so it is not abandoned -- but nobody is looking at it,
      // and a seat someone is not looking at is a seat someone else could have.
      const ids = (await users(CAPACITY + 1)).map((id) => id!);
      for (const id of ids.slice(0, CAPACITY)) await store.access.request(id);
      const waiter = ids[CAPACITY]!;
      await store.access.request(waiter);

      await idleAway(IDLE_MS + 1000, [ids[0]!], [...ids.slice(1, CAPACITY), waiter]);
      expect((await store.access.status(waiter)).state).toBe('active');
      expect((await store.access.status(ids[0]!)).state).toBe('queued');
    });

    it('does not bump someone who is still working', async () => {
      const [a] = (await users(1)).map((id) => id!);
      await store.access.request(a!);
      await advance(20 * 60 * 1000, a!);
      expect((await store.access.status(a!)).state).toBe('active');
    });

    it('re-admits without instantly bumping again', async () => {
      // The stale presence timestamp that caused the bump must not still be stale on return, or
      // someone coming back would be thrown out on the very next pass.
      const ids = (await users(CAPACITY + 1)).map((id) => id!);
      for (const id of ids.slice(0, CAPACITY)) await store.access.request(id);
      const waiter = ids[CAPACITY]!;
      await store.access.request(waiter);

      await idleAway(IDLE_MS + 1000, [ids[0]!], [...ids.slice(1, CAPACITY), waiter]);
      expect((await store.access.status(ids[0]!)).state).toBe('queued');

      await store.access.release(ids[1]!);
      expect((await store.access.heartbeat(ids[0]!)).state).toBe('active');
      await advance(60 * 1000, ids[0]!);
      expect((await store.access.status(ids[0]!)).state).toBe('active');
    });

    it('still ends the seat when the hour runs out while idle', async () => {
      // Idleness sends you to the back of the line; a finished hour is finished either way, and
      // finished means the seat is gone rather than merely surrendered for a moment.
      const [a] = (await users(1)).map((id) => id!);
      await store.access.request(a!);
      await advance(SESSION_MS - 30 * 1000, a!);
      await idleAway(31 * 1000, [a!]);

      const status = await store.access.status(a!);
      expect(status.state).toBe('idle');
      expect(status.lastReason).toBe('expired');
    });

    it('treats a closed tab as leaving, not as idling', async () => {
      // No heartbeat at all is someone who has gone, and the seat goes back to the pool. The
      // grace is longer than the idle window so a page that still exists never lands here by
      // accident.
      const [a] = (await users(1)).map((id) => id!);
      await store.access.request(a!);
      await advance(GRACE_MS + 1000);
      expect((await store.access.status(a!)).state).toBe('idle');
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

  it('defaults to ten seats and an hour each', async () => {
    const defaults = new AccountStore(backends.pool);
    expect(defaults.access.capacity).toBe(10);
    expect(defaults.access.sessionMs).toBe(60 * 60 * 1000);
    expect(defaults.access.idleMs).toBe(2 * 60 * 1000);
  });

  it('never reports a state that no longer exists', async () => {
    // 'cooldown' was a fourth state and is gone. Anything still producing one would be a row the
    // migration missed, and the gate has no screen for it any more.
    const [a] = await users(1);
    await store.access.request(a!);
    await advance(SESSION_MS, a!);
    expect(['idle', 'queued', 'active']).toContain((await store.access.status(a!)).state);
    expect(await store.access.status(a!)).not.toHaveProperty('cooldownUntil');
  });
});
