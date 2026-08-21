/**
 * An invite code arriving in the address bar.
 *
 * Somebody follows `/?invite=ABCD2345`, reads the landing page, presses Try now, decides to make
 * an account -- and by then the query string is three navigations ago. So the code is taken off
 * the URL the moment the app loads and kept until it is either used or a week has passed.
 *
 * The URL is cleaned immediately as well. A code left in the address bar gets bookmarked, shared
 * onward, and pasted into a chat window by somebody who thinks they are sharing the app.
 */
const KEY = 'robo-journey.invite';
/** Long enough to read the page, sleep on it, and come back. Not long enough to be a surprise. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

interface Stored {
  readonly code: string;
  readonly at: number;
}

/** Take a code off the URL, if there is one, and tidy the address bar. */
export function captureInvite(): void {
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('invite');
    if (!code) return;

    window.localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() } satisfies Stored));
    url.searchParams.delete('invite');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  } catch {
    // A blocked localStorage or an odd URL is not a reason to fail to start.
  }
}

/** The code waiting to be used, if it has not gone stale. */
export function pendingInvite(): string | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Stored;
    if (!stored?.code || Date.now() - stored.at > KEEP_MS) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return stored.code;
  } catch {
    return null;
  }
}

/** Spent, or no longer wanted. */
export function clearInvite(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do about it, and nothing depends on it.
  }
}
