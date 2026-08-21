/**
 * Invites.
 *
 * A referral scheme is the part of an application people actively try to break, so these are the
 * tests worth having: inviting yourself, redeeming twice, two racing redemptions, and being paid
 * twice for the same person. Each of those is prevented by a constraint rather than by an `if`,
 * and each is checked here against a real database because that is the only place a constraint
 * exists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore, INVITE_REWARD } from '../src/index.js';
import { createBackends, hasDatabase, type TestBackends } from '../../../test/database.js';

const describeWithDb = hasDatabase() ? describe : describe.skip;
const PASSWORD = 'correct horse battery staple';

describeWithDb('invites', () => {
  let backends: TestBackends;
  let store: AccountStore;
  let ada: string;
  let bob: string;

  beforeEach(async () => {
    backends = await createBackends('invites');
    store = new AccountStore(backends.pool);
    ada = (await store.register('ada@example.com', PASSWORD, 'Ada')).id;
    bob = (await store.register('bob@example.com', PASSWORD, 'Bob')).id;
  });

  afterEach(async () => backends.close());

  it('gives an account the same code every time it asks', async () => {
    const first = await store.invites.codeFor(ada);
    expect(first).toMatch(/^[A-Z0-9]{8}$/);
    expect(await store.invites.codeFor(ada)).toBe(first);
  });

  it('gives different accounts different codes', async () => {
    expect(await store.invites.codeFor(ada)).not.toBe(await store.invites.codeFor(bob));
  });

  it('reads a code back however it was typed', async () => {
    const code = await store.invites.codeFor(ada);
    expect(await store.invites.ownerOf(code.toLowerCase())).toBe(ada);
    expect(await store.invites.ownerOf(`  ${code}  `)).toBe(ada);
  });

  it('records a redemption without paying for it yet', async () => {
    const code = await store.invites.codeFor(ada);
    await store.invites.redeem(code, bob);

    const summary = await store.invites.summaryFor(ada);
    expect(summary.invited).toBe(1);
    // Nothing until the invitee confirms. Paying on sign-up would be paying for anybody who can
    // type an email address.
    expect(summary.confirmed).toBe(0);
    expect(summary.earned).toBe(0);
    expect((await store.credits.balance(ada)).available).toBe(0);
  });

  it('pays when the invitee confirms', async () => {
    const code = await store.invites.codeFor(ada);
    await store.invites.redeem(code, bob);

    const paid = await store.invites.rewardFor(bob);
    expect(paid).toEqual({ inviterId: ada, amount: INVITE_REWARD });
    expect((await store.credits.balance(ada)).available).toBe(INVITE_REWARD);

    const summary = await store.invites.summaryFor(ada);
    expect(summary.confirmed).toBe(1);
    expect(summary.earned).toBe(INVITE_REWARD);
  });

  it('pays exactly once however many times confirmation runs', async () => {
    // Verification can be clicked twice, and the route calls this every time.
    const code = await store.invites.codeFor(ada);
    await store.invites.redeem(code, bob);

    await store.invites.rewardFor(bob);
    expect(await store.invites.rewardFor(bob)).toBeNull();
    expect((await store.credits.balance(ada)).available).toBe(INVITE_REWARD);
  });

  it('pays once when two confirmations race', async () => {
    const code = await store.invites.codeFor(ada);
    await store.invites.redeem(code, bob);

    const results = await Promise.all([
      store.invites.rewardFor(bob),
      store.invites.rewardFor(bob),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.credits.balance(ada)).available).toBe(INVITE_REWARD);
  });

  it('refuses to let anybody invite themselves', async () => {
    const code = await store.invites.codeFor(ada);
    await expect(store.invites.redeem(code, ada)).rejects.toThrow(/cannot invite yourself/i);
  });

  it('refuses a code nobody owns', async () => {
    await expect(store.invites.redeem('ZZZZZZZZ', bob)).rejects.toThrow(/does not belong/i);
    await expect(store.invites.redeem('   ', bob)).rejects.toThrow(/Enter a code/i);
  });

  it('lets an account use one code, ever', async () => {
    const carol = (await store.register('carol@example.com', PASSWORD, 'Carol')).id;
    await store.invites.redeem(await store.invites.codeFor(ada), bob);

    await expect(
      store.invites.redeem(await store.invites.codeFor(carol), bob),
    ).rejects.toThrow(/already used an invite code/i);

    // And the second inviter was not credited for a redemption that did not happen.
    expect((await store.invites.summaryFor(carol)).invited).toBe(0);
  });

  it('keeps only one row when two redemptions race', async () => {
    const code = await store.invites.codeFor(ada);
    const results = await Promise.allSettled([
      store.invites.redeem(code, bob),
      store.invites.redeem(code, bob),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.invites.summaryFor(ada)).invited).toBe(1);
  });

  it('says whether an account has already been invited', async () => {
    expect(await store.invites.hasRedeemed(bob)).toBe(false);
    await store.invites.redeem(await store.invites.codeFor(ada), bob);
    expect(await store.invites.hasRedeemed(bob)).toBe(true);
  });

  it('does nothing for an account nobody invited', async () => {
    expect(await store.invites.rewardFor(bob)).toBeNull();
  });
});
