/**
 * The two guards every protected route needs.
 *
 * Authentication and access are separate questions and both have to be asked. A session cookie
 * says who the caller is; a seat says whether they may use the simulator at this moment. Someone
 * whose hour has run out is still perfectly well authenticated -- they simply cannot compile
 * anything until the cooldown has passed.
 *
 * Which guard a route uses is a real decision, not a formality:
 *
 *   - Compiling and datasheet extraction need a seat. They are the tool, and they are what the
 *     ten-at-a-time limit exists to ration.
 *   - Reading and writing projects need only a session. Someone's hour ending must not take their
 *     unsaved circuit with it, so storage stays reachable through the cooldown.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
// Imported for its declaration merging, which is what puts `cookies` on the request and
// `setCookie` on the reply. The plugin itself is registered once, in `createServer`.
import '@fastify/cookie';
import type { AccountStore, PublicUser } from '@robo-journey/accounts';

export const SESSION_COOKIE = 'rj_session';

export interface Guards {
  /** Whoever is signed in, or null. Never sends a reply. */
  currentUser(request: FastifyRequest): PublicUser | null;
  /** Signed in, or a 401. Returns null once the reply has been sent. */
  requireUser(request: FastifyRequest, reply: FastifyReply): PublicUser | null;
  /** Signed in *and* holding a seat, or a 401/403. Returns null once the reply has been sent. */
  requireSeat(request: FastifyRequest, reply: FastifyReply): PublicUser | null;
}

export function createGuards(store: AccountStore): Guards {
  const currentUser = (request: FastifyRequest): PublicUser | null =>
    store.resolveSession(request.cookies[SESSION_COOKIE]);

  const requireUser = (request: FastifyRequest, reply: FastifyReply): PublicUser | null => {
    const user = currentUser(request);
    if (!user) {
      void reply.status(401).send({ error: 'Not signed in.' });
      return null;
    }
    return user;
  };

  const requireSeat = (request: FastifyRequest, reply: FastifyReply): PublicUser | null => {
    const user = requireUser(request, reply);
    if (!user) return null;

    const status = store.access.status(user.id);
    if (status.state === 'active') return user;

    // 403 rather than 401: the caller is who they say they are, they are simply not allowed
    // through right now. The status travels with the error so the client can show the queue
    // position or the countdown without a second round trip.
    void reply.status(403).send({
      error:
        status.state === 'cooldown'
          ? 'Your session has ended. You can join the queue again once the cooldown is over.'
          : status.state === 'queued'
            ? 'You are still in the queue.'
            : 'You do not have an active session. Join the queue to get one.',
      access: status,
    });
    return null;
  };

  return { currentUser, requireUser, requireSeat };
}
