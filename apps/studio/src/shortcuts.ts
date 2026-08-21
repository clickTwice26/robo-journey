/**
 * Which modifier key this machine uses.
 *
 * Its own module so the menu hints and the shortcuts dialog cannot disagree about whether to say
 * Command or Control -- two copies of this would drift the moment one of them was edited.
 */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const MOD = isMac ? '\u2318' : 'Ctrl+';

/** A shortcut hint as the menus print it. */
export const shortcut = (key: string): string => `${MOD}${key}`;
