/**
 * Ephemeral Postgres and Redis for the test run.
 *
 * Tests run against the real engines, not a stand-in. The whole reason the store moved to Postgres
 * is behaviour SQLite does not have -- advisory locks, enum types, `now()` semantics, real
 * concurrency -- and testing it against something else would prove the wrong thing.
 *
 * Containers are started here rather than assumed to be running, so a fresh checkout tests
 * correctly with nothing set up. When Docker is unavailable the database-backed suites skip with a
 * visible message rather than failing, which keeps the rest of the suite useful.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const POSTGRES_IMAGE = 'postgres:17-alpine';
const REDIS_IMAGE = 'redis:8-alpine';
/** Labelled so a stray container from an interrupted run is easy to find and remove. */
const LABEL = 'robo-journey-test';

interface Started {
  readonly containerId: string;
  readonly port: number;
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await exec('docker', ['info'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a container with its port mapped to one the kernel picks.
 *
 * Publishing to an arbitrary free port rather than a fixed one means a test run never collides
 * with a development stack, or with another run on the same machine.
 */
async function startContainer(
  image: string,
  internalPort: number,
  extraArgs: readonly string[] = [],
): Promise<Started> {
  const { stdout } = await exec('docker', [
    'run',
    '--detach',
    '--rm',
    '--label',
    LABEL,
    '--publish',
    `127.0.0.1::${internalPort}`,
    ...extraArgs,
    image,
  ]);
  const containerId = stdout.trim();

  const { stdout: portLine } = await exec('docker', ['port', containerId, String(internalPort)]);
  const port = Number(portLine.trim().split('\n')[0]?.split(':').pop());
  if (!Number.isFinite(port)) throw new Error(`Could not read the mapped port for ${image}`);

  return { containerId, port };
}

async function waitFor(check: () => Promise<boolean>, what: string, attempts = 80): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what} did not become ready in time`);
}

let containers: string[] = [];

export async function setup(): Promise<void> {
  if (!(await dockerAvailable())) {
    process.env.RJ_TEST_NO_DOCKER = '1';
    console.warn(
      '\n[test] Docker is unavailable — database-backed suites will skip.\n' +
        '       Start Docker to run them.\n',
    );
    return;
  }

  const postgres = await startContainer(POSTGRES_IMAGE, 5432, [
    '--env',
    'POSTGRES_PASSWORD=test',
    '--env',
    'POSTGRES_USER=test',
    '--env',
    'POSTGRES_DB=test',
    // Nothing here outlives the run, so durability is pure cost. This is the one place turning
    // fsync off is right, and it takes a noticeable chunk off the suite.
    '--tmpfs',
    '/var/lib/postgresql/data',
  ]);
  containers.push(postgres.containerId);

  const redis = await startContainer(REDIS_IMAGE, 6379);
  containers.push(redis.containerId);

  await waitFor(
    () =>
      exec('docker', ['exec', postgres.containerId, 'pg_isready', '-U', 'test', '-d', 'test'])
        .then(() => true)
        .catch(() => false),
    'Postgres',
  );
  await waitFor(
    () =>
      exec('docker', ['exec', redis.containerId, 'redis-cli', 'ping'])
        .then(({ stdout }) => stdout.trim() === 'PONG')
        .catch(() => false),
    'Redis',
  );

  // Workers inherit the environment they are forked with, and global setup runs first.
  process.env.TEST_DATABASE_URL = `postgres://test:test@127.0.0.1:${postgres.port}/test`;
  process.env.TEST_REDIS_URL = `redis://127.0.0.1:${redis.port}`;
}

export async function teardown(): Promise<void> {
  await Promise.all(containers.map((id) => exec('docker', ['rm', '-f', id]).catch(() => undefined)));
  containers = [];
}
