/**
 * Schema migrations.
 *
 * Ordered, recorded, and applied under a lock. Every instance runs this on start-up, so several
 * containers coming up together would otherwise all try to create the same table; the advisory
 * lock makes the first one do the work and the rest wait and find nothing to do.
 *
 * Migrations are append-only. Editing one that has already run means the database and the file
 * disagree and nothing will say so, which is how a schema quietly diverges between environments.
 */
import type { Pool, PoolClient } from 'pg';
import { LOCK_MIGRATIONS, withTransaction } from './db.js';

export interface Migration {
  /** Ordering key. Never reused, never renumbered. */
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'accounts',
    sql: `
      CREATE TABLE users (
        id            UUID PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Addresses are compared case-insensitively everywhere; the index makes that lookup cheap
      -- and the constraint makes it impossible for two spellings of one address to both exist.
      CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX sessions_user ON sessions (user_id);
      -- Pruning walks this, and it is the only query that scans by expiry.
      CREATE INDEX sessions_expires ON sessions (expires_at);

      CREATE TABLE projects (
        id         UUID PRIMARY KEY,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        document   JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- Matches the listing query exactly: filtered by owner, newest first.
      CREATE INDEX projects_user_updated ON projects (user_id, updated_at DESC);
    `,
  },
  {
    id: 2,
    name: 'access',
    sql: `
      CREATE TYPE access_state AS ENUM ('idle', 'queued', 'active', 'cooldown');
      CREATE TYPE access_reason AS ENUM ('idle', 'expired');

      CREATE TABLE access (
        user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        state          access_state NOT NULL,
        -- Place in line. A counter and not a timestamp: two people joining in the same instant
        -- have to have an order, and it has to be the order they arrived in.
        queue_seq      BIGINT,
        queued_at      TIMESTAMPTZ,
        started_at     TIMESTAMPTZ,
        expires_at     TIMESTAMPTZ,
        cooldown_until TIMESTAMPTZ,
        last_seen_at   TIMESTAMPTZ NOT NULL,
        last_active_at TIMESTAMPTZ,
        carry_ms       BIGINT,
        last_reason    access_reason
      );

      -- Every reconcile pass reads these three ways: who is queued in order, whose seat has
      -- lapsed, and whose cooldown is over.
      CREATE INDEX access_queue ON access (queue_seq) WHERE state = 'queued';
      CREATE INDEX access_active ON access (expires_at, last_seen_at, last_active_at)
        WHERE state = 'active';
      CREATE INDEX access_cooldown ON access (cooldown_until) WHERE state = 'cooldown';

      -- Gapless and monotonic, which is all the queue needs. A sequence rather than max()+1 so
      -- two concurrent joins cannot be handed the same place in line.
      CREATE SEQUENCE access_queue_seq;
    `,
  },
  {
    id: 3,
    name: 'cooldown-from',
    sql: `
      -- When the cooldown began, as distinct from when it ends. The end moves: a cooldown is set
      -- from how contended the simulator was at the moment a seat was given up, and it is
      -- recalculated as the queue drains, so someone is never held out for a crowd that has since
      -- gone home. Without the start there is nothing to recalculate from.
      ALTER TABLE access ADD COLUMN cooldown_from TIMESTAMPTZ;
    `,
  },
  {
    id: 4,
    name: 'email-verification',
    sql: `
      -- Null means unverified. A boolean would answer "is it verified"; a timestamp also answers
      -- "since when", which is the question asked when an account turns out to be a problem.
      ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;

      CREATE TYPE email_token_kind AS ENUM ('verify', 'reset');

      CREATE TABLE email_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       email_token_kind NOT NULL,
        -- The address the token was issued for. A token stops working if the account's address
        -- changes afterwards, so a link sent to an old mailbox cannot verify a new one.
        email      TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        -- Single use. Recorded rather than deleted so a second click can say "already used"
        -- instead of the same message an invented token gets.
        used_at    TIMESTAMPTZ
      );
      CREATE INDEX email_tokens_user ON email_tokens (user_id, kind);
      CREATE INDEX email_tokens_expires ON email_tokens (expires_at);
    `,
  },
  {
    id: 5,
    name: 'credits',
    sql: `
      -- Balance in whole credits. An integer, never a float: money-like quantities that are
      -- added and subtracted thousands of times must not accumulate representation error, and
      -- "you have 4.999999 credits" is not a sentence anyone should read.
      CREATE TABLE credit_accounts (
        user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        balance    BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
        -- Held against work in flight. Deducted from the balance already; this records how much of
        -- the deduction is provisional so a crash can be reconciled.
        held       BIGINT NOT NULL DEFAULT 0 CHECK (held >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TYPE credit_entry_kind AS ENUM ('grant', 'hold', 'settle', 'release', 'adjustment');

      -- Every movement, in order. The balance could be derived from this and is stored separately
      -- only so reading it is one row rather than a sum over history -- which means the two must
      -- move together, in one transaction, always.
      CREATE TABLE credit_ledger (
        id            BIGSERIAL PRIMARY KEY,
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind          credit_entry_kind NOT NULL,
        -- Signed: negative takes credits away. Reading the sign off the kind would mean encoding
        -- the same fact twice and eventually disagreeing with itself.
        delta         BIGINT NOT NULL,
        balance_after BIGINT NOT NULL,
        -- What it was for, in words, for the history someone actually reads.
        reason        TEXT NOT NULL,
        -- What it was for, machine-readable: 'chat', 'datasheet', 'agent'.
        feature       TEXT NOT NULL,
        -- Ties a settle or a release back to the hold it resolves.
        hold_id       BIGINT REFERENCES credit_ledger(id),
        metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX credit_ledger_user ON credit_ledger (user_id, created_at DESC);
      -- Finding holds that were never resolved, which is what a crash leaves behind.
      CREATE INDEX credit_ledger_open_holds ON credit_ledger (user_id)
        WHERE kind = 'hold';
    `,
  },
  {
    id: 6,
    name: 'invites',
    sql: `
      -- One code per account, made the first time somebody asks for theirs. Not made at signup:
      -- most accounts never invite anybody, and a table of codes nobody will use is a table to
      -- keep unique forever for nothing.
      CREATE TABLE invite_codes (
        user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        code       TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Who joined on whose code. The invitee is the primary key, which is the rule stated as a
      -- constraint rather than as application logic: an account can be invited once, ever, and no
      -- amount of retrying or racing changes that.
      CREATE TABLE invite_redemptions (
        invitee_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        inviter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code       TEXT NOT NULL,
        -- When the inviter was actually paid. Null until the invitee confirms their address --
        -- a reward for an unconfirmed account is a reward for anyone who can type one.
        rewarded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- Inviting yourself is not inviting anybody.
        CONSTRAINT invite_not_self CHECK (invitee_id <> inviter_id)
      );
      CREATE INDEX invite_redemptions_inviter ON invite_redemptions (inviter_id, created_at DESC);
    `,
  },
  {
    id: 7,
    name: 'drop-cooldown',
    sql: `
      -- A seat that ends now leaves the account with nothing rather than holding it out for a
      -- while. Asking again takes a free seat if there is one and joins the back of the queue if
      -- there is not, which is what makes a release-and-retake fair without a timer to enforce it.

      -- Anyone mid-cooldown when this runs is simply free, which is the new rule applied to them.
      UPDATE access SET state = 'idle', cooldown_until = NULL, cooldown_from = NULL
       WHERE state = 'cooldown';

      -- Dropping the column takes its index with it.
      ALTER TABLE access DROP COLUMN cooldown_until;
      ALTER TABLE access DROP COLUMN cooldown_from;

      -- The other two partial indexes have to go first and come back afterwards. Their predicates
      -- hold enum literals, so the moment the column becomes TEXT they are comparing text with
      -- access_state and the whole migration fails on an operator that does not exist.
      DROP INDEX access_queue;
      DROP INDEX access_active;

      -- Postgres cannot remove a value from an enum, so the type is rebuilt without it. Safe only
      -- because of the UPDATE above: no row can still say 'cooldown' by the time this casts.
      ALTER TABLE access ALTER COLUMN state TYPE TEXT;
      DROP TYPE access_state;
      CREATE TYPE access_state AS ENUM ('idle', 'queued', 'active');
      ALTER TABLE access ALTER COLUMN state TYPE access_state USING state::access_state;

      CREATE INDEX access_queue ON access (queue_seq) WHERE state = 'queued';
      CREATE INDEX access_active ON access (expires_at, last_seen_at, last_active_at)
        WHERE state = 'active';
    `,
  },
];

/** Bring the schema up to date. Safe to run concurrently from any number of instances. */
export async function migrate(pool: Pool): Promise<number[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  return withTransaction(pool, async (client) => {
    // Held for the transaction, so it is released even if this process is killed mid-migration.
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_MIGRATIONS]);

    const { rows } = await client.query<{ id: number }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.id));
    const ran: number[] = [];

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [
        migration.id,
        migration.name,
      ]);
      ran.push(migration.id);
    }

    return ran;
  });
}

/** Which migrations the database has, for the readiness check and for diagnosing a bad deploy. */
export async function appliedMigrations(client: Pool | PoolClient): Promise<number[]> {
  const { rows } = await client.query<{ id: number }>(
    'SELECT id FROM schema_migrations ORDER BY id',
  );
  return rows.map((row) => row.id);
}
