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
