/**
 * Invites.
 *
 * Somebody joins on your code, confirms their address, and you get credits. The whole feature is
 * three rules, and each of them is a constraint in the schema rather than a check in code, because
 * a referral scheme is the part of an application people actively try to break:
 *
 *   - An account can be invited once, ever. `invitee_id` is the primary key of the redemption
 *     table, so a retry, a double-click and two racing requests all collapse to the same row.
 *   - You cannot invite yourself. A CHECK constraint, not an `if`.
 *   - The reward is paid once. It goes through `credits.grant` with a reference derived from the
 *     invitee, and that call is already idempotent on its reference.
 *
 * The reward waits for the invitee to confirm their address. Paying on signup would mean paying
 * for anyone who can type an email address, which is the entire attack.
 */
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from './db.js';
import type { CreditStore } from './credits.js';

/** What the inviter gets when someone they invited confirms their account. */
export const INVITE_REWARD = 100;

/**
 * The alphabet codes are drawn from.
 *
 * No O/0, no I/1/L: a code is read off one screen and typed into another, sometimes from a
 * photograph of a screen, and those are the characters that cost people a retry.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function newCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/** Codes are compared upper-case and without spaces, because that is how they get typed. */
export const normaliseCode = (raw: string): string =>
  raw.trim().toUpperCase().replace(/[\s-]/g, '');

export interface InviteSummary {
  readonly code: string;
  /** How many accounts have joined on it. */
  readonly invited: number;
  /** How many of those confirmed, which is how many were paid for. */
  readonly confirmed: number;
  readonly earned: number;
}

export class InviteError extends Error {}

export class Invites {
  constructor(
    private readonly pool: Pool,
    private readonly credits: CreditStore,
  ) {}

  /**
   * This account's code, making one if it has none.
   *
   * Retries on a collision rather than trusting eight random characters to be unique. Thirty-one
   * to the eighth is a large number and `UNIQUE` is a promise; the loop is what turns the second
   * into the first.
   */
  async codeFor(userId: string): Promise<string> {
    const existing = await this.pool.query<{ code: string }>(
      'SELECT code FROM invite_codes WHERE user_id = $1::uuid',
      [userId],
    );
    if (existing.rows[0]) return existing.rows[0].code;

    for (let attempt = 0; attempt < 8; attempt++) {
      const code = newCode();
      const { rows } = await this.pool.query<{ code: string }>(
        `INSERT INTO invite_codes (user_id, code) VALUES ($1::uuid, $2)
         ON CONFLICT (user_id) DO UPDATE SET code = invite_codes.code
         RETURNING code`,
        [userId, code],
      );
      if (rows[0]) return rows[0].code;
    }
    throw new InviteError('Could not make an invite code. Try again.');
  }

  /** Who owns a code, or null. */
  async ownerOf(code: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ user_id: string }>(
      'SELECT user_id FROM invite_codes WHERE code = $1',
      [normaliseCode(code)],
    );
    return rows[0]?.user_id ?? null;
  }

  /**
   * Record that an account joined on a code.
   *
   * Nothing is paid here. The row is the claim; the reward happens when the invitee confirms.
   * Throws with a reason the user can act on, because "invalid code" for four different problems
   * is the sort of message that generates support mail.
   */
  async redeem(code: string, inviteeId: string): Promise<{ inviterId: string }> {
    const normalised = normaliseCode(code);
    if (!normalised) throw new InviteError('Enter a code.');

    const inviterId = await this.ownerOf(normalised);
    if (!inviterId) throw new InviteError('That code does not belong to anybody.');
    if (inviterId === inviteeId) throw new InviteError('You cannot invite yourself.');

    const { rows } = await this.pool.query<{ inviter_id: string }>(
      `INSERT INTO invite_redemptions (invitee_id, inviter_id, code)
       VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT (invitee_id) DO NOTHING
       RETURNING inviter_id`,
      [inviteeId, inviterId, normalised],
    );

    if (!rows[0]) throw new InviteError('This account has already used an invite code.');
    return { inviterId };
  }

  /**
   * Pay the inviter, if this account was invited and has not been paid for yet.
   *
   * Called when an address is confirmed. Safe to call every time: the conditional UPDATE claims
   * the payment, so only the call that wins the race goes on to grant -- and the grant itself is
   * idempotent on its reference besides.
   */
  async rewardFor(inviteeId: string): Promise<{ inviterId: string; amount: number } | null> {
    return withTransaction(this.pool, async (client: PoolClient) => {
      const { rows } = await client.query<{ inviter_id: string }>(
        `UPDATE invite_redemptions SET rewarded_at = now()
          WHERE invitee_id = $1::uuid AND rewarded_at IS NULL
          RETURNING inviter_id`,
        [inviteeId],
      );
      const inviterId = rows[0]?.inviter_id;
      if (!inviterId) return null;

      await this.credits.grant(inviterId, INVITE_REWARD, {
        reason: 'Someone joined on your invite',
        feature: 'invite',
        reference: `invite:${inviteeId}`,
      });

      return { inviterId, amount: INVITE_REWARD };
    });
  }

  /** The code, and what it has brought in. */
  async summaryFor(userId: string): Promise<InviteSummary> {
    const code = await this.codeFor(userId);
    const { rows } = await this.pool.query<{ invited: string; confirmed: string }>(
      `SELECT count(*) AS invited,
              count(*) FILTER (WHERE rewarded_at IS NOT NULL) AS confirmed
         FROM invite_redemptions WHERE inviter_id = $1::uuid`,
      [userId],
    );
    const invited = Number(rows[0]?.invited ?? 0);
    const confirmed = Number(rows[0]?.confirmed ?? 0);
    return { code, invited, confirmed, earned: confirmed * INVITE_REWARD };
  }

  /** Whether this account has already used somebody's code. */
  async hasRedeemed(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM invite_redemptions WHERE invitee_id = $1::uuid',
      [userId],
    );
    return rows.length > 0;
  }
}
