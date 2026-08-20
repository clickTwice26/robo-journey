/**
 * Credits.
 *
 * The tests that matter are the ones about money not being invented or lost. A balance that drifts
 * from its ledger, a grant honoured twice, or two requests both spending the last credit are all
 * failures that only appear under load and are unrecoverable by the time anyone notices -- so they
 * are checked here rather than trusted to careful code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore, InsufficientCreditsError } from '../src/index.js';
import { createBackends, hasDatabase, type TestBackends } from '../../../test/database.js';

const describeWithDb = hasDatabase() ? describe : describe.skip;
const PASSWORD = 'correct horse battery staple';

describeWithDb('credits', () => {
  let backends: TestBackends;
  let store: AccountStore;
  let userId: string;

  beforeEach(async () => {
    backends = await createBackends('credits');
    store = new AccountStore(backends.pool);
    userId = (await store.register('ada@example.com', PASSWORD, 'Ada')).id;
  });

  afterEach(async () => backends.close());

  it('starts at nothing', async () => {
    expect(await store.credits.balance(userId)).toEqual({ available: 0, held: 0 });
  });

  it('adds a grant', async () => {
    await store.credits.grant(userId, 100, { reason: 'Welcome', feature: 'signup' });
    expect((await store.credits.balance(userId)).available).toBe(100);
  });

  it('honours a referenced grant once, however many times it is asked for', async () => {
    // A signup bonus written twice because a request was retried is free money.
    for (let i = 0; i < 3; i++) {
      await store.credits.grant(userId, 100, { reason: 'Welcome', reference: 'signup' });
    }
    expect((await store.credits.balance(userId)).available).toBe(100);
  });

  describe('holding', () => {
    beforeEach(async () => {
      await store.credits.grant(userId, 100, { reason: 'Test' });
    });

    it('takes the estimate out of the balance up front', async () => {
      await store.credits.hold(userId, 30, { reason: 'Chat', feature: 'chat' });
      expect(await store.credits.balance(userId)).toEqual({ available: 70, held: 30 });
    });

    it('refuses what the account cannot afford', async () => {
      await expect(
        store.credits.hold(userId, 101, { reason: 'Chat', feature: 'chat' }),
      ).rejects.toThrow(InsufficientCreditsError);
      expect((await store.credits.balance(userId)).available).toBe(100);
    });

    it('cannot be raced into an overdraft', async () => {
      // The property the whole design turns on. Ten simultaneous requests, each affordable alone
      // and not together: exactly five can succeed, and the balance never goes below zero.
      const attempts = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          store.credits.hold(userId, 20, { reason: 'Chat', feature: 'chat' }),
        ),
      );

      const taken = attempts.filter((a) => a.status === 'fulfilled').length;
      expect(taken).toBe(5);
      const balance = await store.credits.balance(userId);
      expect(balance.available).toBe(0);
      expect(balance.held).toBe(100);
    });

    it('gives back what was not used', async () => {
      // A model's cost is not known until it has answered, so the estimate is deliberately
      // generous and the difference comes back.
      const hold = await store.credits.hold(userId, 40, { reason: 'Chat', feature: 'chat' });
      await store.credits.settle(hold, 12, { reason: 'Chat' });
      expect(await store.credits.balance(userId)).toEqual({ available: 88, held: 0 });
    });

    it('will not charge more than was held', async () => {
      // The hold is the ceiling the account agreed to. An estimate that turns out low is the
      // caller's problem to size better, not the account holder's to pay for.
      const hold = await store.credits.hold(userId, 10, { reason: 'Chat', feature: 'chat' });
      await store.credits.settle(hold, 999, { reason: 'Chat' });
      expect(await store.credits.balance(userId)).toEqual({ available: 90, held: 0 });
    });

    it('returns everything when the work failed', async () => {
      // Nobody pays for an answer they did not get.
      const hold = await store.credits.hold(userId, 40, { reason: 'Chat', feature: 'chat' });
      await store.credits.release(hold);
      expect(await store.credits.balance(userId)).toEqual({ available: 100, held: 0 });
    });
  });

  describe('the ledger', () => {
    it('always agrees with the balance', async () => {
      // The balance is a cache over this. A cache that can drift from its source is worse than no
      // cache, so every movement writes both in one transaction.
      await store.credits.grant(userId, 100, { reason: 'Test' });
      const first = await store.credits.hold(userId, 40, { reason: 'Chat', feature: 'chat' });
      await store.credits.settle(first, 15, { reason: 'Chat' });
      const second = await store.credits.hold(userId, 25, { reason: 'Chat', feature: 'chat' });
      await store.credits.release(second);

      const history = await store.credits.history(userId);
      const summed = history.reduce((total, entry) => total + entry.delta, 0);
      expect(summed).toBe((await store.credits.balance(userId)).available);
      expect(history[0]!.balanceAfter).toBe(summed);
    });

    it('records what each movement was for', async () => {
      await store.credits.grant(userId, 50, { reason: 'Welcome', feature: 'signup' });
      const hold = await store.credits.hold(userId, 20, { reason: 'Asked about a circuit', feature: 'chat' });
      await store.credits.settle(hold, 6, { reason: 'Answered' });

      const history = await store.credits.history(userId);
      expect(history.map((e) => e.kind)).toEqual(['settle', 'hold', 'grant']);
      expect(history.find((e) => e.kind === 'hold')!.feature).toBe('chat');
      // A settle inherits the feature of the hold it resolves, so a run reads as one thing.
      expect(history.find((e) => e.kind === 'settle')!.feature).toBe('chat');
    });

    it('is newest first', async () => {
      await store.credits.grant(userId, 10, { reason: 'One' });
      await store.credits.grant(userId, 10, { reason: 'Two' });
      expect((await store.credits.history(userId))[0]!.reason).toBe('Two');
    });
  });
});
