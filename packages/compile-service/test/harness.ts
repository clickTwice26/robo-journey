/**
 * A server wired to a throwaway Postgres schema and Redis namespace.
 *
 * Shared by both integration suites so there is one place that knows how a server is assembled for
 * a test, and one place to change when that assembly does.
 */
import { createServer, type ServerParts } from '../src/server.js';
import { loadConfig, type Config } from '../src/config.js';
import { migrate } from '@robo-journey/accounts';
import { createBackends, hasDatabase, type TestBackends } from '../../../test/database.js';

export { hasDatabase };

export interface TestServer extends ServerParts {
  /** Simulated time, so an hour-long session does not take an hour. */
  readonly clock: { now: number };
  readonly backends: TestBackends;
  destroy(): Promise<void>;
}

export interface TestServerOptions {
  readonly capacity?: number;
  readonly sessionMinutes?: number;
  readonly cooldownMinutes?: number;
  readonly idleMinutes?: number;
}

/**
 * Configuration for a test server.
 *
 * Built from the real loader so the schema is exercised too -- a required variable added without a
 * default would fail here rather than in production.
 */
function testConfig(backends: TestBackends, options: TestServerOptions): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    REDIS_URL: process.env.TEST_REDIS_URL,
    LOG_LEVEL: 'silent',
    RJ_ACCESS_CAPACITY: String(options.capacity ?? 2),
    RJ_ACCESS_SESSION_MINUTES: String(options.sessionMinutes ?? 60),
    RJ_ACCESS_COOLDOWN_MINUTES: String(options.cooldownMinutes ?? 20),
    RJ_ACCESS_IDLE_MINUTES: String(options.idleMinutes ?? 2),
  } as NodeJS.ProcessEnv);
}

const open: TestServer[] = [];

export async function startTestServer(
  name: string,
  options: TestServerOptions = {},
): Promise<TestServer> {
  const backends = await createBackends(name);
  await migrate(backends.pool);

  const clock = { now: Date.UTC(2026, 0, 1, 12, 0, 0) };
  const parts = await createServer({
    config: testConfig(backends, options),
    pool: backends.pool,
    redis: backends.redis,
    access: { now: () => clock.now },
  });

  const server: TestServer = {
    ...parts,
    clock,
    backends,
    async destroy() {
      // The pool and the client belong to the harness, so the server is told to let go of them
      // rather than closing them underneath it.
      await parts.app.close();
      await backends.close();
    },
  };
  open.push(server);
  return server;
}

/** Tear down anything a test forgot. */
export async function closeAllTestServers(): Promise<void> {
  await Promise.all(open.splice(0).map((server) => server.destroy().catch(() => undefined)));
}
