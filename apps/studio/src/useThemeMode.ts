/**
 * Which theme the app is in, and who decided.
 *
 * Three states rather than two, because "dark" and "follows my system" are different answers and
 * collapsing them means someone who never expressed a preference gets whichever one we guessed.
 * The default is `system`, so the app matches the rest of the machine until told otherwise.
 *
 * Stored in localStorage rather than in the account: a theme belongs to the screen you are sitting
 * at, and someone who works dark at night and light at a desk should not have the two fight.
 */
import { useEffect, useState } from 'react';
import type { ThemeMode, ThemePreference } from './theme.ts';

const STORAGE_KEY = 'robo-journey.theme';

const PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

export function storedPreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : 'system';
  } catch {
    // Private browsing, or storage disabled. Following the system is a fine place to land.
    return 'system';
  }
}

export function storePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Not being able to remember the choice is not a reason to refuse to make it.
  }
}

const systemMode = (): ThemeMode =>
  window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

export interface ThemeControl {
  /** What the user asked for. */
  readonly preference: ThemePreference;
  /** What that resolves to right now. */
  readonly mode: ThemeMode;
  setPreference(preference: ThemePreference): void;
}

export function useThemeMode(): ThemeControl {
  const [preference, setPreferenceState] = useState<ThemePreference>(storedPreference);
  const [system, setSystem] = useState<ThemeMode>(systemMode);

  // Track the system setting even while an explicit preference is in force, so switching back to
  // `system` lands on the right one immediately rather than on whatever it was at start-up.
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!query) return;
    const onChange = () => setSystem(query.matches ? 'light' : 'dark');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const mode: ThemeMode = preference === 'system' ? system : preference;

  return {
    preference,
    mode,
    setPreference: (next) => {
      storePreference(next);
      setPreferenceState(next);
    },
  };
}
