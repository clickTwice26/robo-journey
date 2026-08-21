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
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import {
  TokenError,
  consumeEmailToken,
  issueEmailToken,
  type EmailTokenKind,
} from '@robo-journey/accounts';
import { RedisRateLimiter } from './redis.js';
import { SESSION_COOKIE, type Guards } from './session-guard.js';
import { passwordResetMessage, verificationMessage, type Mailer } from './mailer.js';

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
function createLimiters(redis: Redis) {
  return {
    loginByAddress: new RedisRateLimiter(redis, 30, 5 * 60 * 1000, 'login-ip'),
    loginByAccount: new RedisRateLimiter(redis, 5, 15 * 60 * 1000, 'login-account'),
    registerByAddress: new RedisRateLimiter(redis, 40, 60 * 60 * 1000, 'register-ip'),
    // Mail costs money and reputation, and a resend button is a way to have someone else's inbox
    // filled. Tight per account and per address.
    mailByAccount: new RedisRateLimiter(redis, 5, 60 * 60 * 1000, 'mail-account'),
    mailByAddress: new RedisRateLimiter(redis, 15, 60 * 60 * 1000, 'mail-ip'),
  };
}

/** Ceiling on stored projects per account, so one user cannot fill the disk. */
const MAX_PROJECTS = 200;
/** Largest project document accepted, bytes. A big circuit is tens of kilobytes. */
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

/** Byte length as stored, so a document of multi-byte characters is measured honestly. */
function documentTooLarge(document: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(document) ?? '') > MAX_DOCUMENT_BYTES;
}

interface Credentials {
  inviteCode?: string;
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
  readonly redis: Redis;
  readonly pool: Pool;
  readonly mailer: Mailer;
  /** Origin the links in outgoing mail point at. */
  readonly publicUrl: string;
  /** Whether an address must be proved before an account can take a seat. */
  readonly requireVerifiedEmail: boolean;
  /** Credits a confirmed account starts with. */
  readonly signupCredits: number;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { store, guards, redis, pool, mailer, publicUrl, requireVerifiedEmail, signupCredits } =
    options;

  /**
   * Hand a confirmed account its starting credits.
   *
   * Keyed on a reference so it happens once however many times this runs -- a retried request or a
   * second verification click must not be a second allowance. Granted on confirmation rather than
   * at signup because an allowance given to an unconfirmed address is an allowance given to
   * anybody who can type one.
   */
  const grantSignupCredits = async (userId: string): Promise<void> => {
    if (signupCredits <= 0) return;
    try {
      await store.credits.grant(userId, signupCredits, {
        reason: 'Welcome to robo-journey',
        feature: 'signup',
        reference: 'signup',
      });
    } catch (error) {
      // The account is verified either way; credits can be added by hand. Failing the request here
      // would leave someone unable to get in over a bookkeeping problem.
      app.log.error({ err: error, userId }, 'could not grant signup credits');
    }
  };
  const { currentUser, requireUser } = guards;
  const { loginByAddress, loginByAccount, registerByAddress, mailByAccount, mailByAddress } =
    createLimiters(redis);

  const linkTo = (path: string, token: string): string =>
    new URL(`${path}?token=${encodeURIComponent(token)}`, publicUrl).toString();

  /**
   * Issue a link and send it.
   *
   * Never throws into the caller. A mail server having a bad minute must not fail a signup: the
   * account exists either way, and "we could not send that, try resend" is a far better place to
   * be than a 500 that leaves someone unsure whether they have an account at all.
   */
  const sendLink = async (
    userId: string,
    email: string,
    kind: EmailTokenKind,
  ): Promise<boolean> => {
    try {
      const { token } = await issueEmailToken(pool, userId, email, kind);
      const message =
        kind === 'verify'
          ? verificationMessage(email, linkTo('/verify', token))
          : passwordResetMessage(email, linkTo('/reset-password', token));
      return await mailer.send(message);
    } catch (error) {
      app.log.error({ err: error, kind }, 'could not send account mail');
      return false;
    }
  };

  /**
   * Join the queue, tolerating a cooldown.
   *
   * Signing in during a cooldown is a perfectly ordinary thing to do -- someone comes back to see
   * how long is left -- so it must not fail the sign-in. The status returned says where they
   * stand either way.
   */
  const requestOrReport = async (user: {
    id: string;
    emailVerified: boolean;
  }): Promise<AccessStatus> => {
    // An unverified account gets no seat, so it is not put in the queue either -- holding a place
    // in a line it cannot reach the front of would be a worse experience than being told why.
    if (requireVerifiedEmail && !user.emailVerified) return store.access.status(user.id);
    try {
      return await store.access.request(user.id);
    } catch (error) {
      if (error instanceof CooldownError) return store.access.status(user.id);
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
    const user = await currentUser(request);
    // The access status and the balance travel with the identity: the app needs all three to
    // decide what to render, and three round trips to draw one screen is three too many.
    return reply.send({
      user,
      access: user ? await store.access.status(user.id) : null,
      credits: user ? await store.credits.balance(user.id) : null,
    });
  });

  app.post<{ Body: Credentials }>('/auth/register', async (request, reply) => {
    const address = request.ip;
    const limit = await registerByAddress.check(address);
    if (!limit.allowed) {
      return reply
        .status(429)
        .header('Retry-After', limit.retryAfter)
        .send({ error: `Too many sign-ups from here. Try again in ${limit.retryAfter}s.` });
    }

    const { email, password, displayName, inviteCode } = request.body ?? {};
    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required.' });
    }

    try {
      const user = await store.register(email, password, displayName ?? '');
      const session = await store.createSession(user.id);
      setSessionCookie(request, reply, session.token);

      // A bad code must not cost somebody their sign-up. The account is made either way and the
      // code can be entered again from inside the app.
      if (inviteCode?.trim()) {
        await store.invites.redeem(inviteCode, user.id).catch(() => undefined);
      }

      const mailSent = requireVerifiedEmail ? await sendLink(user.id, user.email, 'verify') : true;
      // Nothing to confirm when confirmation is switched off, so the allowance is due now.
      if (!requireVerifiedEmail) await grantSignupCredits(user.id);
      // Signed in immediately: making someone log in again right after registering is friction
      // with no security benefit. Registration is free and unlimited -- it is the *seat* that is
      // rationed -- so a new account goes straight into the queue like any other.
      return reply.status(201).send({ user, access: await requestOrReport(user), mailSent });
    } catch (error) {
      return sendAccountError(reply, error);
    }
  });

  app.post<{ Body: Credentials }>('/auth/login', async (request, reply) => {
    const { email, password } = request.body ?? {};
    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required.' });
    }

    const [byAddress, byAccount] = await Promise.all([
      loginByAddress.check(request.ip),
      loginByAccount.check(email.trim().toLowerCase()),
    ]);
    if (!byAddress.allowed || !byAccount.allowed) {
      const retryAfter = Math.max(byAddress.retryAfter, byAccount.retryAfter);
      return reply
        .status(429)
        .header('Retry-After', retryAfter)
        .send({ error: `Too many attempts. Try again in ${retryAfter}s.` });
    }

    try {
      const user = await store.authenticate(email, password);
      const session = await store.createSession(user.id);
      setSessionCookie(request, reply, session.token);
      // A successful sign-in clears the account's counter, so one forgotten password does not
      // lock someone out for the rest of the window.
      await loginByAccount.reset(email.trim().toLowerCase());
      // Signing in is what puts someone in the queue: there is no separate button to press, and
      // no state where they are signed in and have not asked for a seat.
      return reply.send({ user, access: await requestOrReport(user) });
    } catch (error) {
      return sendAccountError(reply, error);
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    // Give the seat back on the way out, so signing out frees it for whoever is waiting rather
    // than leaving it held by nobody until the heartbeat grace runs out.
    const user = await currentUser(request);
    if (user) await store.access.release(user.id);

    await store.destroySession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  app.post('/auth/logout-everywhere', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    await store.access.release(user.id);
    await store.destroyAllSessions(user.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.send({ ok: true });
  });

  // --- Email verification -------------------------------------------------------------------------

  /**
   * Spend a verification link.
   *
   * A GET, because it is reached by clicking a link in a mail client, and it works without a
   * session: the link may well be opened in a different browser from the one that signed up, and
   * the token is the proof, not the cookie.
   *
   * It answers with JSON here and the app turns it into a screen; the route the browser lands on
   * is served by the SPA, which calls this.
   */
  app.post<{ Body: { token?: string } }>('/auth/verify', async (request, reply) => {
    const token = request.body?.token;
    if (!token) return reply.status(400).send({ error: 'Missing token.' });

    try {
      const { userId } = await consumeEmailToken(pool, token, 'verify');
      await store.markEmailVerified(userId);
      await grantSignupCredits(userId);
      // Whoever invited them gets paid now rather than at signup, for the same reason the signup
      // allowance waits: a reward for an unconfirmed address is a reward for anyone who can type
      // one. Safe to call every time -- it claims the payment with a conditional UPDATE.
      await store.invites.rewardFor(userId).catch((error: unknown) => {
        app.log.error({ err: error, userId }, 'could not pay an invite reward');
        return null;
      });
      const user = await store.findUser(userId);

      // Signed in on the spot when the link is opened in the browser that already holds the
      // session, and simply verified when it is not. Either way the next thing they see is the
      // app rather than a form.
      const current = await currentUser(request);
      return reply.send({
        ok: true,
        user,
        access: user && current?.id === user.id ? await requestOrReport(user) : null,
      });
    } catch (error) {
      if (error instanceof TokenError) {
        return reply.status(400).send({ error: verifyFailureMessage(error.failure) });
      }
      throw error;
    }
  });

  /** Send another verification link. Signed in, because it is asking about your own address. */
  app.post('/auth/resend-verification', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.emailVerified) return reply.send({ ok: true, alreadyVerified: true });

    const [byAccount, byAddress] = await Promise.all([
      mailByAccount.check(user.id),
      mailByAddress.check(request.ip),
    ]);
    if (!byAccount.allowed || !byAddress.allowed) {
      const retryAfter = Math.max(byAccount.retryAfter, byAddress.retryAfter);
      return reply
        .status(429)
        .header('Retry-After', retryAfter)
        .send({ error: `Another link was sent recently. Try again in ${retryAfter}s.` });
    }

    return reply.send({ ok: await sendLink(user.id, user.email, 'verify') });
  });

  // --- Password reset -----------------------------------------------------------------------------

  /**
   * Ask for a reset link.
   *
   * Always answers the same way, whether or not the address is registered. Saying "no such
   * account" here turns this endpoint into a way to find out who has one.
   */
  app.post<{ Body: { email?: string } }>('/auth/forgot-password', async (request, reply) => {
    const email = request.body?.email;
    const answer = {
      ok: true,
      message: 'If that address has an account, a reset link is on its way.',
    };
    if (!email) return reply.send(answer);

    const byAddress = await mailByAddress.check(request.ip);
    if (!byAddress.allowed) {
      return reply
        .status(429)
        .header('Retry-After', byAddress.retryAfter)
        .send({ error: `Too many requests. Try again in ${byAddress.retryAfter}s.` });
    }

    const user = await store.findUserByEmail(email);
    if (user && (await mailByAccount.check(user.id)).allowed) {
      await sendLink(user.id, user.email, 'reset');
    }
    return reply.send(answer);
  });

  app.post<{ Body: { token?: string; password?: string } }>(
    '/auth/reset-password',
    async (request, reply) => {
      const { token, password } = request.body ?? {};
      if (!token || !password) {
        return reply.status(400).send({ error: 'A token and a new password are required.' });
      }

      try {
        const { userId, email } = await consumeEmailToken(pool, token, 'reset');
        // Strength is checked inside, and a weak one throws before anything is written.
        await store.setPassword(userId, password);

        // Reaching the mailbox proves the address as surely as a verification link does, so an
        // account that resets its password without having verified is verified by doing it.
        await store.markEmailVerified(userId);

        // Every session was destroyed by the reset, including this one if it was the same browser.
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        return reply.send({ ok: true, email });
      } catch (error) {
        if (error instanceof TokenError) {
          return reply.status(400).send({ error: resetFailureMessage(error.failure) });
        }
        return sendAccountError(reply, error);
      }
    },
  );

  // --- Access ------------------------------------------------------------------------------------

  app.get('/access', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    return reply.send({ access: await store.access.status(user.id) });
  });

  app.post('/access', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;

    if (requireVerifiedEmail && !user.emailVerified) {
      return reply.status(403).send({
        error: 'Confirm your email address before taking a seat.',
        access: await store.access.status(user.id),
      });
    }

    try {
      return reply.send({ access: await store.access.request(user.id) });
    } catch (error) {
      if (error instanceof CooldownError) {
        return reply
          .status(429)
          .header('Retry-After', Math.ceil((error.until.getTime() - Date.now()) / 1000))
          .send({ error: error.message, access: await store.access.status(user.id) });
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
    const user = await requireUser(request, reply);
    if (!user) return reply;
    // Absent means the page is open but nobody is at it. Defaults to present so a client that
    // does not report it is never punished for the omission.
    const present = request.body?.present !== false;
    return reply.send({ access: await store.access.heartbeat(user.id, present) });
  });

  app.post('/access/release', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    return reply.send({ access: await store.access.release(user.id) });
  });

  // --- Projects -----------------------------------------------------------------------------------

  app.get('/projects', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    return reply.send({ projects: await store.listProjects(user.id) });
  });

  app.get<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;

    const project = await store.getProject(user.id, request.params.id);
    // Someone else's project and a missing one are the same answer, so an id guess cannot confirm
    // that a project exists.
    if (!project) return reply.status(404).send({ error: 'No such project.' });
    return reply.send({ project });
  });

  app.post<{ Body: ProjectBody }>('/projects', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;

    const body = request.body ?? {};
    const document = body.document ?? {};
    // Measured as it would be stored, not as the object it currently is. The column is JSONB, so
    // the document is passed through as a value rather than pre-encoded -- encoding it here and
    // again in the driver would store a JSON string containing JSON.
    if (documentTooLarge(document)) {
      return reply.status(413).send({ error: 'That project is too large to store.' });
    }
    if ((await store.countProjects(user.id)) >= MAX_PROJECTS) {
      return reply
        .status(409)
        .send({ error: `You have reached the limit of ${MAX_PROJECTS} saved projects.` });
    }

    return reply
      .status(201)
      .send({ project: await store.createProject(user.id, body.name ?? 'Untitled', document) });
  });

  app.put<{ Params: { id: string }; Body: ProjectBody }>('/projects/:id', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;

    const body = request.body ?? {};
    const document = body.document ?? {};
    if (documentTooLarge(document)) {
      return reply.status(413).send({ error: 'That project is too large to store.' });
    }

    try {
      return reply.send({
        project: await store.updateProject(user.id, request.params.id, body.name ?? 'Untitled', document),
      });
    } catch (error) {
      return sendAccountError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    try {
      await store.deleteProject(user.id, request.params.id);
      return reply.send({ ok: true });
    } catch (error) {
      return sendAccountError(reply, error);
    }
  });
}


/**
 * Why a link did not work, in words.
 *
 * Each failure gets its own message because each has a different next step, and "invalid token"
 * for all four leaves someone with nothing to do about it.
 */
function verifyFailureMessage(failure: string): string {
  switch (failure) {
    case 'expired':
      return 'That link has expired. Sign in and ask for another.';
    case 'used':
      return 'That link has already been used. Your address is confirmed -- just sign in.';
    case 'address-changed':
      return 'That link was sent to a different address than the account now uses.';
    default:
      return 'That link is not valid. Sign in and ask for another.';
  }
}

function resetFailureMessage(failure: string): string {
  switch (failure) {
    case 'expired':
      return 'That reset link has expired. Reset links last an hour -- ask for another.';
    case 'used':
      return 'That reset link has already been used. Ask for another if you still need one.';
    case 'address-changed':
      return 'That link was sent to a different address than the account now uses.';
    default:
      return 'That reset link is not valid. Ask for another.';
  }
}
