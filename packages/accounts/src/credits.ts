/**
 * Credits, and the ledger behind them.
 *
 * AI features cost real money per call, so they are metered. Two properties matter more than
 * anything else here, and both are the kind that only fail under load:
 *
 * **Nobody can spend what they do not have.** Two requests arriving together must not both see a
 * balance of ten and both take eight. That is not solved by reading then writing, however careful
 * the code between; it is solved by making the check part of the write, which is what the
 * conditional UPDATE below does. It changes no rows when the balance is short, and a row count is
 * not something two transactions can disagree about.
 *
 * **The balance and the ledger never diverge.** The balance could be a sum over the ledger and is
 * stored separately only so reading it costs one row instead of a scan over history. That is a
 * cache, and a cache that can drift from its source is worse than no cache -- so every movement
 * writes both, in one transaction, always.
 *
 * A language model's cost is not known until after it has answered, so spending is two steps: hold
 * an estimate up front, then settle against what it actually cost. That is also what makes the
 * agent work later: a run that takes minutes and calls a model repeatedly holds once and settles
 * once, rather than discovering halfway through that the account ran dry.
 */
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from './db.js';

/** What a credit movement was for. Open-ended: agents and whatever follows use the same ledger. */
export type CreditFeature = 'chat' | 'datasheet' | 'agent' | 'signup' | 'admin';

export type CreditEntryKind = 'grant' | 'hold' | 'settle' | 'release' | 'adjustment';

export interface CreditBalance {
  /** Spendable right now: what is left after anything held against work in flight. */
  readonly available: number;
  /** Held against calls that have not finished. */
  readonly held: number;
}

export interface LedgerEntry {
  readonly id: string;
  readonly kind: CreditEntryKind;
  readonly delta: number;
  readonly balanceAfter: number;
  readonly reason: string;
  readonly feature: string;
  readonly createdAt: string;
}

/** A claim on credits that has not been settled yet. */
export interface Hold {
  readonly id: string;
  readonly userId: string;
  readonly amount: number;
}

export class InsufficientCreditsError extends Error {
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super(`Needs ${required} credits, ${available} available.`);
    this.name = 'InsufficientCreditsError';
  }
}

const toNumber = (value: string | number): number => Number(value);

export class CreditStore {
  constructor(private readonly pool: Pool) {}

  /** Open an account, if there is not one. Idempotent, so it is safe to call on every request. */
  async ensureAccount(userId: string, client: Pool | PoolClient = this.pool): Promise<void> {
    await client.query(
      'INSERT INTO credit_accounts (user_id) VALUES ($1::uuid) ON CONFLICT (user_id) DO NOTHING',
      [userId],
    );
  }

  async balance(userId: string): Promise<CreditBalance> {
    const { rows } = await this.pool.query<{ balance: string; held: string }>(
      'SELECT balance, held FROM credit_accounts WHERE user_id = $1::uuid',
      [userId],
    );
    const row = rows[0];
    return {
      available: row ? toNumber(row.balance) : 0,
      held: row ? toNumber(row.held) : 0,
    };
  }

  /**
   * Add credits.
   *
   * Used for the allowance a new account starts with and for anything added by hand later.
   * `reference` makes a grant idempotent: a signup bonus written twice because a request was
   * retried would be free money, so the same reference is only ever honoured once.
   */
  async grant(
    userId: string,
    amount: number,
    { reason, feature = 'admin', reference }: { reason: string; feature?: CreditFeature; reference?: string },
  ): Promise<CreditBalance> {
    if (amount <= 0) throw new RangeError('A grant must be positive.');

    return withTransaction(this.pool, async (client) => {
      await this.ensureAccount(userId, client);

      if (reference) {
        const { rows } = await client.query(
          `SELECT 1 FROM credit_ledger
            WHERE user_id = $1::uuid AND kind = 'grant' AND metadata->>'reference' = $2`,
          [userId, reference],
        );
        if (rows.length > 0) return this.readBalance(client, userId);
      }

      const { rows } = await client.query<{ balance: string }>(
        `UPDATE credit_accounts SET balance = balance + $2, updated_at = now()
          WHERE user_id = $1::uuid RETURNING balance`,
        [userId, amount],
      );
      const balanceAfter = toNumber(rows[0]!.balance);

      await client.query(
        `INSERT INTO credit_ledger (user_id, kind, delta, balance_after, reason, feature, metadata)
         VALUES ($1::uuid, 'grant', $2, $3, $4, $5, $6::jsonb)`,
        [userId, amount, balanceAfter, reason, feature, JSON.stringify(reference ? { reference } : {})],
      );

      return this.readBalance(client, userId);
    });
  }

  /**
   * Claim credits for work about to start.
   *
   * The conditional UPDATE is the whole safety property: `balance >= $2` inside the statement
   * means the check and the deduction are one operation, so two requests cannot both pass a check
   * that only one of them can afford. Reading the balance first and deciding in application code
   * looks equivalent and is not.
   */
  async hold(
    userId: string,
    amount: number,
    { reason, feature }: { reason: string; feature: CreditFeature },
  ): Promise<Hold> {
    if (amount < 0) throw new RangeError('A hold cannot be negative.');

    return withTransaction(this.pool, async (client) => {
      await this.ensureAccount(userId, client);

      const { rows } = await client.query<{ balance: string }>(
        `UPDATE credit_accounts
            SET balance = balance - $2, held = held + $2, updated_at = now()
          WHERE user_id = $1::uuid AND balance >= $2
          RETURNING balance`,
        [userId, amount],
      );

      if (rows.length === 0) {
        const current = await this.readBalance(client, userId);
        throw new InsufficientCreditsError(amount, current.available);
      }

      const balanceAfter = toNumber(rows[0]!.balance);
      const entry = await client.query<{ id: string }>(
        `INSERT INTO credit_ledger (user_id, kind, delta, balance_after, reason, feature)
         VALUES ($1::uuid, 'hold', $2, $3, $4, $5) RETURNING id`,
        [userId, -amount, balanceAfter, reason, feature],
      );

      return { id: entry.rows[0]!.id, userId, amount };
    });
  }

  /**
   * Resolve a hold against what the work actually cost.
   *
   * Charging more than was held is refused rather than allowed to overdraw: the hold is the
   * ceiling the account agreed to, and an estimate that turns out low is the caller's problem to
   * size better, not the account holder's to pay for. The difference comes back either way.
   */
  async settle(
    hold: Hold,
    actual: number,
    { reason, metadata = {} }: { reason: string; metadata?: Record<string, unknown> } = {
      reason: 'Settled',
    },
  ): Promise<CreditBalance> {
    const charged = Math.max(0, Math.min(Math.round(actual), hold.amount));
    const refund = hold.amount - charged;

    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ balance: string }>(
        `UPDATE credit_accounts
            SET balance = balance + $2, held = GREATEST(0, held - $3), updated_at = now()
          WHERE user_id = $1::uuid
          RETURNING balance`,
        [hold.userId, refund, hold.amount],
      );
      const balanceAfter = rows[0] ? toNumber(rows[0].balance) : 0;

      await client.query(
        `INSERT INTO credit_ledger
           (user_id, kind, delta, balance_after, reason, feature, hold_id, metadata)
         VALUES ($1::uuid, 'settle', $2, $3, $4,
                 (SELECT feature FROM credit_ledger WHERE id = $5), $5, $6::jsonb)`,
        [
          hold.userId,
          refund,
          balanceAfter,
          reason,
          hold.id,
          JSON.stringify({ ...metadata, held: hold.amount, charged }),
        ],
      );

      return this.readBalance(client, hold.userId);
    });
  }

  /** Give a hold back in full, for work that failed. Nobody pays for an answer they did not get. */
  async release(hold: Hold, reason = 'Released'): Promise<CreditBalance> {
    return this.settle(hold, 0, { reason });
  }

  /** Recent movements, newest first, for the history someone actually reads. */
  async history(userId: string, limit = 50): Promise<LedgerEntry[]> {
    const { rows } = await this.pool.query<{
      id: string;
      kind: CreditEntryKind;
      delta: string;
      balance_after: string;
      reason: string;
      feature: string;
      created_at: Date;
    }>(
      `SELECT id, kind, delta, balance_after, reason, feature, created_at
         FROM credit_ledger WHERE user_id = $1::uuid
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, Math.min(limit, 200)],
    );

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      delta: toNumber(row.delta),
      balanceAfter: toNumber(row.balance_after),
      reason: row.reason,
      feature: row.feature,
      createdAt: row.created_at.toISOString(),
    }));
  }

  private async readBalance(client: PoolClient, userId: string): Promise<CreditBalance> {
    const { rows } = await client.query<{ balance: string; held: string }>(
      'SELECT balance, held FROM credit_accounts WHERE user_id = $1::uuid',
      [userId],
    );
    const row = rows[0];
    return { available: row ? toNumber(row.balance) : 0, held: row ? toNumber(row.held) : 0 };
  }
}
