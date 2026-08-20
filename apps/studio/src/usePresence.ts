/**
 * Is anyone actually there?
 *
 * A seat is held only while it is being used, so the client has to answer a question the server
 * cannot: is this page in front of a person right now. Two things have to be true -- the tab is
 * the one being looked at, and someone has touched the keyboard, mouse or screen recently. A page
 * left open in a background tab is alive but not in use, and that is precisely the case this
 * exists to detect.
 *
 * Deliberately not React state on every event. Mouse movement fires dozens of times a second, and
 * re-rendering the whole workspace on each one to update a timestamp nobody looks at would be a
 * far worse problem than the one being solved. The timestamp lives in a ref; only the derived
 * "about to be bumped" warning is state, and it changes at most once a second.
 */
import { useEffect, useRef, useState } from 'react';

/**
 * What counts as being there.
 *
 * Pointer movement covers mouse, pen and touch in one event; the rest catch someone working
 * entirely from the keyboard, or scrolling through a long sketch without moving the pointer.
 */
const ACTIVITY_EVENTS = [
  'pointermove',
  'pointerdown',
  'keydown',
  'wheel',
  'touchstart',
  'focus',
] as const;

export interface Presence {
  /** True when the tab is visible and there has been input inside the window. */
  current(): boolean;
  /** Milliseconds until the seat is given up, or null when there is nothing to warn about. */
  readonly warningMs: number | null;
}

export interface PresenceOptions {
  /** How long without input before the seat is passed on. Matches the server's rule. */
  readonly idleMs: number;
  /** How long before that to start warning. */
  readonly warnAtMs: number;
  /** False while there is no seat to lose, so nothing is watched. */
  readonly enabled: boolean;
}

export function usePresence({ idleMs, warnAtMs, enabled }: PresenceOptions): Presence {
  const lastInput = useRef<number>(Date.now());
  const [warningMs, setWarningMs] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setWarningMs(null);
      return;
    }

    // Starting the clock now rather than trusting whatever it held from a previous session: the
    // seat has only just been taken.
    lastInput.current = Date.now();

    const touch = () => {
      lastInput.current = Date.now();
    };
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, touch, { passive: true });
    }

    // Coming back to the tab is itself a sign of presence, and the most common way someone
    // returns -- switching tabs produces no pointer or key event at all.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') touch();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const tick = () => {
      const idleFor = Date.now() - lastInput.current;
      const hidden = document.visibilityState !== 'visible';
      const remaining = idleMs - idleFor;
      // A hidden tab cannot show a warning, so there is no point computing one for it; what
      // matters there is that the heartbeat reports it as not present, which it does.
      setWarningMs(!hidden && remaining <= warnAtMs ? Math.max(0, remaining) : null);
    };
    tick();
    const timer = setInterval(tick, 1000);

    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, touch);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(timer);
    };
  }, [enabled, idleMs, warnAtMs]);

  return {
    current: () =>
      document.visibilityState === 'visible' && Date.now() - lastInput.current < idleMs,
    warningMs,
  };
}
