/**
 * Process entry point.
 *
 * Separate from `server.ts` so that importing the server -- which tests do -- never binds a port
 * or installs a signal handler. The only thing here is the part that owns the process.
 */
import { start, type ServerParts } from './server.js';
import { ConfigError } from './config.js';

/**
 * How long to let in-flight requests finish before giving up on them.
 *
 * Shorter than the orchestrator's own grace period, so the process exits on its own terms rather
 * than being killed mid-request. Kubernetes defaults to thirty seconds; Compose to ten.
 */
const SHUTDOWN_TIMEOUT_MS = 8_000;

async function main(): Promise<void> {
  let parts: ServerParts;
  try {
    parts = await start();
  } catch (error) {
    // Configuration problems are not stack traces. Somebody is looking at this in a container log
    // wondering which variable they missed, and the answer should be the first thing they read.
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(78); // EX_CONFIG, so an orchestrator can tell this from a crash.
    }
    console.error('Failed to start:', error);
    process.exit(1);
  }

  parts.app.log.info('service ready');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    // A second signal during shutdown means somebody is impatient; honour it rather than ignoring
    // them and appearing hung.
    if (shuttingDown) {
      parts.app.log.warn({ signal }, 'second signal, exiting now');
      process.exit(1);
    }
    shuttingDown = true;
    parts.app.log.info({ signal }, 'shutting down');

    const timer = setTimeout(() => {
      parts.app.log.error('shutdown timed out, exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // Nothing else is keeping the loop alive by then, and this timer should not be the thing that
    // does.
    timer.unref();

    try {
      await parts.close();
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      parts.app.log.error(error, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A promise nobody caught, or an error outside any request, leaves the process in a state it
  // cannot reason about. Log it and let the orchestrator restart into a known one -- carrying on
  // is how a service ends up half-working in a way nothing detects.
  process.on('unhandledRejection', (reason) => {
    parts.app.log.fatal({ reason }, 'unhandled rejection');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    parts.app.log.fatal(error, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

void main();
