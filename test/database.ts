/**
 * Per-suite database and cache, isolated from every other suite.
 *
 * Each suite gets its own Postgres schema and its own Redis key prefix, so suites running in
 * parallel cannot see each other's rows or counters. Sharing one schema and truncating between
 * tests is the usual shortcut and it serialises the whole suite; a schema per suite costs a
 * `CREATE SCHEMA` and keeps them independent.
 */
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { migrate } from '@robo-journey/accounts';

/** Set by global setup when Docker is not available. */
export const hasDatabase = (): boolean => Boolean(process.env.TEST_DATABASE_URL);

let counter = 0;

export interface TestBackends {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly schema: string;
  close(): Promise<void>;
}

/**
 * A migrated schema and a clean Redis namespace.
 *
 * `search_path` is set on every connection the pool hands out, so the same queries that run
 * against `public` in production run against this suite's schema here with nothing rewritten.
 */
export async function createBackends(name: string): Promise<TestBackends> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('No test database. Global setup should have provided one.');

  const schema = `t_${name.replace(/\W+/g, '_').toLowerCase()}_${++counter}`;

  const admin = new Pool({ connectionString: url, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }

  const pool = new Pool({
    connectionString: url,
    max: 4,
    // Every pooled connection starts pointed at this suite's schema. Done on connect rather than
    // per query because a connection returned to the pool keeps its settings, and one missed
    // statement would write to the wrong schema without saying so.
    options: `-c search_path="${schema}"`,
  });
  pool.on('error', () => undefined);

  await migrate(pool);

  const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379', {
    keyPrefix: `${schema}:`,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redis.on('error', () => undefined);

  return {
    pool,
    redis,
    schema,
    async close() {
      await pool.end();
      redis.disconnect();

      const cleanup = new Pool({ connectionString: url, max: 1 });
      try {
        await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
