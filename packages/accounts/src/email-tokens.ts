/**
 * One-time links: verifying an address, and resetting a password.
 *
 * Both are the same shape -- a secret in a URL that proves control of a mailbox -- so they share
 * one table and one set of rules, and the rules are the same ones session tokens follow:
 *
 *   - Stored only as a SHA-256 of themselves, so a copy of the database is not a set of live
 *     links. This matters more here than for sessions: a reset token is a password.
 *   - Single use, recorded rather than deleted, so clicking a link twice can say "already used"
 *     instead of giving the same answer an invented token would.
 *   - Bound to the address they were issued for, so a link sent to an old mailbox cannot verify
 *     or reset an account whose address has since changed.
 *   - Short-lived, and shorter for a reset than for a verification: one is a convenience, the
 *     other is a credential.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type EmailTokenKind = 'verify' | 'reset';

/**
 * How long each kind lasts.
 *
 * A day for verification, because someone signs up, gets distracted, and comes back in the
 * evening. An hour for a reset, because a live reset link in an inbox is a live credential and the
 * window it is useful for is the few minutes after asking for it.
 */
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export interface IssuedToken {
  /** The secret that goes in the link. Never stored. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface ConsumedToken {
  readonly userId: string;
  readonly email: string;
  readonly kind: EmailTokenKind;
}

/** Why a link did not work. The caller turns these into messages; they are not shown raw. */
export type TokenFailure = 'unknown' | 'expired' | 'used' | 'address-changed';

export class TokenError extends Error {
  constructor(readonly failure: TokenFailure) {
    super(`Token ${failure}`);
    this.name = 'TokenError';
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64');
}

const ttlFor = (kind: EmailTokenKind): number =>
  kind === 'verify' ? VERIFY_TOKEN_TTL_MS : RESET_TOKEN_TTL_MS;

/**
 * Issue a link, invalidating any earlier one of the same kind.
 *
 * Superseding matters for resets: leaving every previously requested token live means an inbox
 * accumulates working credentials, and the oldest is the one most likely to have been forwarded,
 * screenshotted or left on a shared machine.
 */
export async function issueEmailToken(
  client: Pool | PoolClient,
  userId: string,
  email: string,
  kind: EmailTokenKind,
): Promise<IssuedToken> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlFor(kind));

  await client.query(
    `UPDATE email_tokens SET used_at = now()
      WHERE user_id = $1::uuid AND kind = $2::email_token_kind AND used_at IS NULL`,
    [userId, kind],
  );
  await client.query(
    `INSERT INTO email_tokens (token_hash, user_id, kind, email, expires_at)
     VALUES ($1, $2::uuid, $3::email_token_kind, $4, $5::timestamptz)`,
    [hashToken(token), userId, kind, email, expiresAt],
  );

  return { token, expiresAt };
}

/**
 * Spend a link.
 *
 * Marking it used and reading it are one statement, so two clicks arriving together cannot both
 * succeed -- which for a reset token would be two people setting a password from one link.
 */
export async function consumeEmailToken(
  client: Pool | PoolClient,
  token: string,
  kind: EmailTokenKind,
): Promise<ConsumedToken> {
  const { rows } = await client.query<{
    user_id: string;
    email: string;
    current_email: string;
    expires_at: Date;
    used_at: Date | null;
  }>(
    `SELECT t.user_id, t.email, u.email AS current_email, t.expires_at, t.used_at
       FROM email_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.kind = $2::email_token_kind`,
    [hashToken(token), kind],
  );

  const row = rows[0];
  if (!row) throw new TokenError('unknown');
  if (row.used_at) throw new TokenError('used');
  if (row.expires_at.getTime() <= Date.now()) throw new TokenError('expired');
  if (row.current_email.toLowerCase() !== row.email.toLowerCase()) {
    throw new TokenError('address-changed');
  }

  const claimed = await client.query(
    `UPDATE email_tokens SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL
      RETURNING user_id`,
    [hashToken(token)],
  );
  // Lost the race with a concurrent click.
  if (claimed.rowCount === 0) throw new TokenError('used');

  return { userId: row.user_id, email: row.email, kind };
}

/** Housekeeping, so spent and expired rows do not accumulate forever. */
export async function pruneEmailTokens(client: Pool): Promise<number> {
  const result = await client.query(
    `DELETE FROM email_tokens WHERE expires_at <= now() - interval '7 days'`,
  );
  return result.rowCount ?? 0;
}
