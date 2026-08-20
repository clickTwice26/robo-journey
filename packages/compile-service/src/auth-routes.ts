/**
 * Accounts, sessions and project storage over HTTP.
 *
 * Everything secret stays here. The browser receives a session cookie it cannot read from
 * JavaScript and never sees a password hash, a token hash, or the database.
 *
 * The cookie is `httpOnly` so a script injection cannot steal it, `sameSite: strict` so another
 * site cannot ride it, and `secure` whenever the request arrived over HTTPS -- but not on plain
 * localhost, where a secure cookie would simply never be stored and sign-in would silently fail
 * in development.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AccountError,
  AccountStore,
  CooldownError,
  EmailInUseError,
  InvalidCredentialsError,
  NotFoundError,
  SESSION_TTL_MS,
  WeakPasswordError,
  type AccessStatus,
} from '@robo-journey/accounts';
import { RateLimiter } from './rate-limit.js';
import { SESSION_COOKIE, type Guards } from './session-guard.js';

/**
 * Limits.
 *
 * Login is the tighter one because it is the endpoint worth guessing at. Registration is limited
 * only to stop a script filling the database.
 *
 * The registration limit is per address, and a shared network is one address: a class of thirty
 * signing up at once is one IP making thirty requests, which is indistinguishable from abuse by
 * shape alone. It is set high enough for that to work, because accounts are free and are not the
 * scarce thing here -- seats are, and they are limited separately and absolutely. A stricter
 * limit would protect a row in a table at the cost of locking out a room full of people.
 *
 * Built per server rather than at module scope: shared limiter state would leak between instances,
 * which is wrong for tests that each expect a clean slate and would be wrong again for any setup
 * that runs more than one server in a process.
 */
function createLimiters() {
  return {
    loginByAddress: new RateLimiter(30, 5 * 60 * 1000),
    loginByAccount: new RateLimiter(5, 15 * 60 * 1000),
    registerByAddress: new RateLimiter(40, 60 * 60 * 1000),
  };
}

/** Ceiling on stored projects per account, so one user cannot fill the disk. */
const MAX_PROJECTS = 200;
/** Largest project document accepted, bytes. A big circuit is tens of kilobytes. */
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

interface Credentials {
  email?: string;
  password?: string;
  displayName?: string;
}

interface ProjectBody {
  name?: string;
  document?: unknown;
}

export interface AuthRouteOptions {
  readonly store: AccountStore;
  readonly guards: Guards;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { store, guards } = options;
  const { currentUser, requireUser } = guards;
  const { loginByAddress, loginByAccount, registerByAddress } = createLimiters();

  /**
   * Join the queue, tolerating a cooldown.
   *
   * Signing in during a cooldown is a perfectly ordinary thing to do -- someone comes back to see
   * how long is left -- so it must not fail the sign-in. The status returned says where they
   * stand either way.
   */
  const requestOrReport = (userId: string): AccessStatus => {
    try {
      return store.access.request(userId);
    } catch (error) {
      if (error instanceof CooldownError) return store.access.status(userId);
      throw error;
    }
  };

  const setSessionCookie = (request: FastifyRequest, reply: FastifyReply, token: string): void => {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      // Only over HTTPS. On plain localhost a secure cookie is never stored, and sign-in would
      // fail with no visible reason.
      secure: request.protocol === 'https',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  };

  /**
   * Map a domain error onto the right status, without leaking which half was wrong.
   *
   * Order matters and is not arbitrary: every specific error extends `AccountError`, so checking
   * the base class first would swallow all of them into one status. NotFoundError did exactly that
   * and returned 400 for a project that was not there.
   */
  const sendAccountError = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof InvalidCredentialsError) {
      return reply.status(401).send({ error: error.message });
    }
    if (error instanceof EmailInUseError) {
      return reply.status(409).send({ error: error.message });
    }
    if (error instanceof NotFoundError) {
      return reply.status(404).send({ error: error.message });
    }
    if (error instanceof WeakPasswordError) {
      return reply.status(400).send({ error: error.message });
    }
    // The general case, checked last so no subclass reaches it by accident.
    if (error instanceof AccountError) {
      return reply.status(400).send({ error: error.message });
    }
    throw error;
  };

  // --- Auth ---------------------------------------------------------------------------------------

  app.get('/auth/me', async (request, reply) => {
    const user = currentUser(request);
    // The access status travels with the identity, so the app can decide in one request whether to
    // show the workspace, the queue or the countdown.
    return reply.send({ user, access: user ? store.access.status(user.id) : null });
  });

  app.post<{ Body: Credentials }>('/auth/register', async (request, reply) => {
    const address = request.ip;
    const limit = registerByAddress.check(`register:${address}`);
    if (!limit.allowed) {
      return reply
        .status(429)
        .header('Retry-After', limit.retryAfter)
        .send({ error: `Too many sign-ups from here. Try again in ${limit.retryAfter}s.` });
    }

    const { email, password, displayName } = request.body ?? {};
    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required.' });
    }

    try {
      const user = await store.register(email, password, displayName ?? '');
      const session = store.createSession(user.id);
      setSessionCookie(request, reply, session.token);
      // Signed in immediately: making someone log in again right after registering is friction
      // with no security benefit. Registration is free and unlimited -- it is the *seat* that is
      // rationed -- so a new account goes straight into the queue like any other.
      return reply.status(201).send({ user, access: requestOrReport(user.id) });
    } catch (error) {
      return sendAccountError(reply, error);
    }
  });

  app.post<{ Body: Credentials }>('/auth/login', async (request, reply) => {
    const { email, password } = request.body ?? {};
    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required.' });
    }

    const byAddress = loginByAddress.check(`login:${request.ip}`);
    const byAccount = loginByAccount.check(`login:${email.trim().toLowerCase()}`);
    if (!byAddress.allowed || !byAccount.allowed) {
      const retryAfter = Math.max(byAddress.retryAfter, byAccount.retryAfter);
      return reply
        .status(429)
        .header('Retry-After', retryAfter)
        .send({ error: `Too many attempts. Try again in ${retryAfter}s.` });
    }

    try {
      const user = await store.authenticate(email, password);
      const session = store.createSession(user.id);
      setSessionCookie(request, reply, session.token);
      // A successful sign-in clears the account's counter, so one forgotten password does not
      // lock someone out for the rest of the window.
      loginByAccount.reset(`login:${email.trim().toLowerCase()}`);
      // Signing in is what puts someone in the queue: there is no separate button to press, and
      // no state where they are signed in and have not asked for a seat.
      return reply.send({ user, access: requestOrReport(user.id) });
    } catch (error) {
      return sendAccountError(reply, error);
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    // Give the seat back on the way out, so signing out frees it for whoever is waiting rather
    // than leaving it held by nobody until the heartbeat grace runs out.
    const user = currentUser(request);
    if (user) store.access.release(user.id);

    store.destroySession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.post('/auth/logout-everywhere', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    store.access.release(user.id);
    store.destroyAllSessions(user.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  // --- Access ------------------------------------------------------------------------------------

  /**
   * How busy the place is. The only endpoint here that needs no account.
   *
   * Shown on the sign-in screen, so someone can see there is a queue before typing a password
   * rather than after.
   */
  app.get('/access/occupancy', async (_request, reply) =>
    reply.send({ occupancy: store.access.occupancy() }),
  );

  app.get('/access', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    return reply.send({ access: store.access.status(user.id) });
  });

  app.post('/access', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;

    try {
      return reply.send({ access: store.access.request(user.id) });
    } catch (error) {
      if (error instanceof CooldownError) {
        return reply
          .status(429)
          .header('Retry-After', Math.ceil((error.until.getTime() - Date.now()) / 1000))
          .send({ error: error.message, access: store.access.status(user.id) });
      }
      throw error;
    }
  });

  /**
   * Still here.
   *
   * Polled by anyone queued or holding a seat. It is also how the client learns it has been
   * admitted, or that its hour is over, so it doubles as the status endpoint while waiting.
   */
  app.post<{ Body: { present?: boolean } }>('/access/heartbeat', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    // Absent means the page is open but nobody is at it. Defaults to present so a client that
    // does not report it is never punished for the omission.
    const present = request.body?.present !== false;
    return reply.send({ access: store.access.heartbeat(user.id, present) });
  });

  app.post('/access/release', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    return reply.send({ access: store.access.release(user.id) });
  });

  // --- Projects -----------------------------------------------------------------------------------

  app.get('/projects', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    return reply.send({ projects: store.listProjects(user.id) });
  });

  app.get<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;

    const project = store.getProject(user.id, request.params.id);
    // Someone else's project and a missing one are the same answer, so an id guess cannot confirm
    // that a project exists.
    if (!project) return reply.status(404).send({ error: 'No such project.' });
    return reply.send({ project });
  });

  app.post<{ Body: ProjectBody }>('/projects', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;

    const body = request.body ?? {};
    const document = JSON.stringify(body.document ?? {});
    if (document.length > MAX_DOCUMENT_BYTES) {
      return reply.status(413).send({ error: 'That project is too large to store.' });
    }
    if (store.countProjects(user.id) >= MAX_PROJECTS) {
      return reply
        .status(409)
        .send({ error: `You have reached the limit of ${MAX_PROJECTS} saved projects.` });
    }

    return reply
      .status(201)
      .send({ project: store.createProject(user.id, body.name ?? 'Untitled', document) });
  });

  app.put<{ Params: { id: string }; Body: ProjectBody }>('/projects/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;

    const body = request.body ?? {};
    const document = JSON.stringify(body.document ?? {});
    if (document.length > MAX_DOCUMENT_BYTES) {
      return reply.status(413).send({ error: 'That project is too large to store.' });
    }

    try {
      return reply.send({
        project: store.updateProject(user.id, request.params.id, body.name ?? 'Untitled', document),
      });
    } catch (error) {
      return sendAccountError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    try {
      store.deleteProject(user.id, request.params.id);
      return reply.send({ ok: true });
    } catch (error) {
      return sendAccountError(reply, error);
    }
  });
}
