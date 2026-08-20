/**
 * The gate: whether the simulator may be used at all, right now.
 *
 * One hook owns the whole lifecycle -- who is signed in, where they stand in the queue, and the
 * heartbeat that keeps a seat alive -- because these are not independent. Splitting them would
 * mean two pieces of state that can disagree about whether the workspace should be on screen.
 *
 * The heartbeat is also the poll. It is how the app finds out it has been admitted, and how it
 * finds out its hour is over, so there is exactly one thing talking to the server about access and
 * one place where the answer arrives.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePresence } from './usePresence.ts';
import {
  AuthError,
  ServiceUnreachableError,
  fetchSession,
  heartbeat,
  logout as logoutRequest,
  requestAccess,
  type AccessStatus,
  type User,
} from './auth.ts';

/**
 * How often to check in.
 *
 * Faster while queued than while seated: someone watching a queue wants to know the moment it is
 * their turn, whereas someone working does not need to be told anything until their hour is up.
 * Both are comfortably inside the server's ninety second grace, so a single missed request never
 * costs a seat.
 */
const HEARTBEAT_ACTIVE_MS = 30_000;
const HEARTBEAT_QUEUED_MS = 10_000;

/**
 * How long without input costs the seat. Must match the server, which is the one that enforces it.
 *
 * The warning starts well before the end, because a seat vanishing with no notice while someone
 * is reading their own code would be indefensible. Thirty seconds is enough to move a mouse.
 */
export const IDLE_LIMIT_MS = 2 * 60 * 1000;
export const IDLE_WARN_AT_MS = 30 * 1000;

export type AccessPhase =
  /** Still finding out. */
  | 'loading'
  /** The account service is not answering, so nothing can be checked. */
  | 'unreachable'
  | 'signed-out'
  /** Signed in with no seat and no cooldown -- can ask for one. */
  | 'idle'
  | 'queued'
  | 'active'
  | 'cooldown';

export interface AccessGate {
  readonly phase: AccessPhase;
  readonly user: User | null;
  readonly access: AccessStatus | null;
  readonly error: string | null;
  /**
   * Milliseconds until an idle seat is handed on, or null when there is nothing to warn about.
   *
   * Surfaced so the workspace can say so in place rather than letting the screen change without
   * explanation.
   */
  readonly idleWarningMs: number | null;
  /** Accept the result of a sign-in or registration. */
  adopt(user: User, access: AccessStatus | null): void;
  /** Join the queue, or rejoin after a cooldown. */
  join(): Promise<void>;
  /** Give up the seat and sign out. */
  signOut(): Promise<void>;
  /** Re-check everything, for the retry button. */
  refresh(): Promise<void>;
}

function phaseOf(user: User | null, access: AccessStatus | null): AccessPhase {
  if (!user) return 'signed-out';
  if (!access) return 'idle';
  return access.state;
}

export function useAccess(): AccessGate {
  const [phase, setPhase] = useState<AccessPhase>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [access, setAccess] = useState<AccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Guards against a slow response from a previous phase overwriting a newer one. */
  const generation = useRef(0);

  // Watched only while there is a seat to lose. Someone in the queue is waiting, not idling, and
  // it would be perverse to demand they keep moving the mouse to hold a place they have not got.
  const presence = usePresence({
    idleMs: IDLE_LIMIT_MS,
    warnAtMs: IDLE_WARN_AT_MS,
    enabled: phase === 'active',
  });

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const session = await fetchSession();
      if (generation.current !== mine) return;
      setUser(session.user);
      setAccess(session.access);
      setPhase(phaseOf(session.user, session.access));
      setError(null);
    } catch (caught) {
      if (generation.current !== mine) return;
      // Authentication is required to use the tool at all, so a service that is not answering is
      // not a degraded mode -- it is a stop. Saying so plainly beats a login form that can never
      // succeed.
      setPhase(caught instanceof ServiceUnreachableError ? 'unreachable' : 'signed-out');
      setError(caught instanceof AuthError ? caught.message : (caught as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const adopt = useCallback((next: User, nextAccess: AccessStatus | null) => {
    generation.current++;
    setUser(next);
    setAccess(nextAccess);
    setPhase(phaseOf(next, nextAccess));
    setError(null);
  }, []);

  const join = useCallback(async () => {
    try {
      const next = await requestAccess();
      setAccess(next);
      setPhase(phaseOf(user, next));
      setError(null);
    } catch (caught) {
      setError(caught instanceof AuthError ? caught.message : (caught as Error).message);
      // A refused request still tells us where we stand, so pick that up rather than leaving the
      // screen showing a stale state alongside an error.
      await refresh();
    }
  }, [refresh, user]);

  const signOut = useCallback(async () => {
    try {
      await logoutRequest();
    } catch {
      // Signing out locally matters more than the round trip succeeding.
    }
    generation.current++;
    setUser(null);
    setAccess(null);
    setPhase('signed-out');
  }, []);

  /**
   * The heartbeat.
   *
   * Runs only while queued or seated, which are the only states the server tracks liveness for.
   * A 403 means the seat is gone -- the hour ran out between beats -- and the status the server
   * sends with it is authoritative, so it is taken rather than guessed at.
   */
  useEffect(() => {
    if (phase !== 'active' && phase !== 'queued') return;

    let cancelled = false;
    const beat = async () => {
      try {
        // Queued is always reported as present: waiting is not idling, and nobody should have to
        // keep a queue page busy to hold their place in it.
        const next = await heartbeat(phase === 'queued' ? true : presence.current());
        if (cancelled) return;
        setAccess(next);
        setPhase(phaseOf(user, next));
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ServiceUnreachableError) {
          setPhase('unreachable');
          setError(caught.message);
          return;
        }
        // Session gone entirely: back to the sign-in screen rather than a silent stall.
        if (caught instanceof AuthError && caught.status === 401) {
          setUser(null);
          setAccess(null);
          setPhase('signed-out');
        }
      }
    };

    const interval = phase === 'queued' ? HEARTBEAT_QUEUED_MS : HEARTBEAT_ACTIVE_MS;
    const timer = setInterval(() => void beat(), interval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, presence, user]);

  /*
   * There is deliberately no "release the seat on the way out" beacon here.
   *
   * It looks like an easy win -- hand the seat over the moment a tab closes instead of waiting for
   * the heartbeat to lapse -- and it is a trap. Neither `unload` nor `pagehide` can tell a close
   * from a reload, and releasing a seat starts a cooldown, so pressing F5 would put someone out of
   * their own session. A seat occasionally sitting idle for a couple of minutes is a far smaller
   * cost than that, and the grace period exists to cover exactly this case. Signing out, which is
   * unambiguous, releases the seat properly.
   */

  return {
    phase,
    user,
    access,
    error,
    idleWarningMs: presence.warningMs,
    adopt,
    join,
    signOut,
    refresh,
  };
}
