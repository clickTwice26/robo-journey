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
import cookie from '@fastify/cookie';
import {
  AccountError,
  AccountStore,
  EmailInUseError,
  InvalidCredentialsError,
  NotFoundError,
  SESSION_TTL_MS,
  WeakPasswordError,
  type PublicUser,
} from '@robo-journey/accounts';
import { RateLimiter } from './rate-limit.js';

const SESSION_COOKIE = 'rj_session';

/**
 * Limits.
 *
 * Login is the tighter one because it is the endpoint worth guessing at. Registration is limited
 * mostly to stop a script filling the database.
 *
 * Built per server rather than at module scope: shared limiter state would leak between instances,
 * which is wrong for tests that each expect a clean slate and would be wrong again for any setup
 * that runs more than one server in a process.
 */
function createLimiters() {
  return {
    loginByAddress: new RateLimiter(10, 5 * 60 * 1000),
    loginByAccount: new RateLimiter(5, 15 * 60 * 1000),
    registerByAddress: new RateLimiter(5, 60 * 60 * 1000),
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
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): Promise<void> {
  const { store } = options;
  const { loginByAddress, loginByAccount, registerByAddress } = createLimiters();
  await app.register(cookie);

  /** Whoever is signed in, or null. */
  const currentUser = (request: FastifyRequest): PublicUser | null =>
    store.resolveSession(request.cookies[SESSION_COOKIE]);

  /** Guard for everything that needs an account. */
  const requireUser = (request: FastifyRequest, reply: FastifyReply): PublicUser | null => {
    const user = currentUser(request);
    if (!user) {
      void reply.status(401).send({ error: 'Not signed in.' });
      return null;
    }
    return user;
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
    return reply.send({ user });
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
      // with no security benefit.
      return reply.status(201).send({ user });
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
      return reply.send({ user });
    } catch (error) {
      return sendAccountError(reply, error);
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    store.destroySession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.post('/auth/logout-everywhere', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    store.destroyAllSessions(user.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
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
