/**
 * The database connection, and everything about talking to it that is not a query.
 *
 * Postgres rather than a file, because more than one process has to see the same truth. The queue
 * is the reason: two service instances handing out the tenth seat at the same moment is a
 * correctness bug, not a performance one, and no amount of care inside a single process prevents
 * it. Postgres gives transactions and advisory locks that do.
 *
 * Everything here is deliberately explicit -- timeouts, pool limits, retry -- because the defaults
 * are tuned for a laptop and the failure modes they produce in a container are the slow, confusing
 * kind: a request that hangs rather than one that fails.
 */
import { Pool, type PoolClient, type PoolConfig } from 'pg';

export interface DatabaseOptions {
  /** Standard Postgres URL. */
  readonly url: string;
  /** Maximum pooled connections. Postgres has a global cap, so every instance shares the budget. */
  readonly poolSize?: number;
  /** How long a query may run before it is cancelled. Nothing here should take seconds. */
  readonly statementTimeoutMs?: number;
  /** How long to wait for a free connection before failing the request. */
  readonly connectionTimeoutMs?: number;
  /** Shown in `pg_stat_activity`, so a stuck query can be traced to what opened it. */
  readonly applicationName?: string;
  /** Verify the server certificate. Off only where the network itself is the boundary. */
  readonly ssl?: boolean;
}

const DEFAULT_POOL_SIZE = 10;
const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Build the pool.
 *
 * `statement_timeout` is set per connection rather than left to the server default of none. An
 * unbounded query on a pooled connection does not just fail slowly, it holds a connection out of
 * a pool of ten, and enough of them stall every other request behind it.
 */
export function createPool(options: DatabaseOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.url,
    max: options.poolSize ?? DEFAULT_POOL_SIZE,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    // Recycled rather than kept forever, so a long-lived instance does not accumulate connections
    // wedged by a network device that dropped them without telling either end.
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 3600,
    application_name: options.applicationName ?? 'robo-journey',
    statement_timeout: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  };

  const pool = new Pool(config);

  // An idle client erroring is not tied to any request, so without a listener it reaches the
  // process as an unhandled error and takes the service down. Logged and dropped: the pool
  // replaces the connection on its own.
  pool.on('error', (error) => {
    console.error('[db] idle client error', error);
  });

  return pool;
}

/**
 * Wait for the database to accept connections.
 *
 * Compose health checks order startup, but they are not a guarantee -- a restarted Postgres, a
 * failover, or a slow first boot all leave the service starting against a database that is not
 * ready yet. Retrying beats crash-looping: the container comes up once and waits.
 */
export async function waitForDatabase(
  pool: Pool,
  { attempts = 30, delayMs = 1000 }: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
        return;
      } finally {
        client.release();
      }
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `Database did not become available after ${attempts} attempts: ${String(lastError)}`,
  );
}

/**
 * Run a function inside a transaction, rolling back on any throw.
 *
 * The client is passed in rather than taken from the pool inside, because every statement in a
 * transaction has to run on the same connection. Taking a fresh one per query -- easy to do by
 * accident when the pool is the interface -- silently spreads a transaction across connections and
 * the isolation it was there to provide simply is not there.
 */
export async function withTransaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the pool will discard it.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Advisory lock keys.
 *
 * Postgres advisory locks are a shared namespace of arbitrary integers, so the numbers have to be
 * chosen once and written down. Both are transaction-scoped, which means they release when the
 * transaction ends -- including when it ends because the process died, which is the property that
 * matters.
 */
export const LOCK_MIGRATIONS = 8_267_001;
export const LOCK_ACCESS_RECONCILE = 8_267_002;
