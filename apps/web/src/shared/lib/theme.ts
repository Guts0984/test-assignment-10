export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_STORAGE_KEY = 'shop-theme';

/** Anything unknown (empty, tampered storage value) falls back to following the system. */
export function parseTheme(raw: unknown): Theme {
  return THEMES.find((t) => t === raw) ?? 'system';
}

export function isDark(theme: Theme, systemPrefersDark: boolean): boolean {
  return theme === 'dark' || (theme === 'system' && systemPrefersDark);
}

export function readStoredTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system'; // storage can be blocked (private mode): the theme still works for this visit
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // not persisted - nothing else to do
  }
}

export function applyTheme(theme: Theme): void {
  const dark = isDark(theme, window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/**
 * Runs in <head> before the first paint so a dark-theme visitor never sees a white flash.
 * Same rules as `parseTheme` + `isDark`, kept tiny because it is inlined into every page.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var d=t==='dark'||((t!=='light')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;
