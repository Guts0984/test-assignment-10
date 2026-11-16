import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeSwitcher } from '@/features/theme-switcher';
import { isDark, parseTheme, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from '@/shared/lib/theme';
import { renderWith } from './render';

let systemDark = false;
let mqListeners: (() => void)[] = [];

beforeEach(() => {
  systemDark = false;
  mqListeners = [];
  localStorage.clear();
  document.documentElement.className = '';
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return systemDark;
      },
      addEventListener: (_: string, cb: () => void) => mqListeners.push(cb),
      removeEventListener: (_: string, cb: () => void) => {
        mqListeners = mqListeners.filter((l) => l !== cb);
      },
    })),
  );
});
afterEach(() => vi.unstubAllGlobals());

const isDarkNow = () => document.documentElement.classList.contains('dark');

describe('theme logic', () => {
  it('unknown or tampered values fall back to "system"', () => {
    for (const bad of [null, undefined, '', 'Dark', 'blue', '<script>', 42, {}])
      expect(parseTheme(bad)).toBe('system');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
  });
  it('an explicit choice beats the OS, "system" follows it', () => {
    expect(isDark('dark', false)).toBe(true);
    expect(isDark('light', true)).toBe(false);
    expect(isDark('system', true)).toBe(true);
    expect(isDark('system', false)).toBe(false);
  });
});

describe('pre-paint init script (what runs in <head>)', () => {
  const run = () => new Function(THEME_INIT_SCRIPT)();
  it('stored "dark" -> dark even if the OS is light', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    run();
    expect(isDarkNow()).toBe(true);
  });
  it('stored "light" -> light even if the OS is dark', () => {
    systemDark = true;
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    run();
    expect(isDarkNow()).toBe(false);
  });
  it('nothing or garbage stored -> follows the OS', () => {
    systemDark = true;
    run();
    expect(isDarkNow()).toBe(true);
    document.documentElement.className = '';
    localStorage.setItem(THEME_STORAGE_KEY, 'evil');
    run();
    expect(isDarkNow()).toBe(true);
  });
  it('blocked storage does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(run).not.toThrow();
    vi.restoreAllMocks();
  });
});

describe('ThemeSwitcher', () => {
  it('switches the class, remembers the choice and marks the pressed button', () => {
    renderWith(<ThemeSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(isDarkNow()).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(isDarkNow()).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
  it('restores the stored choice after mount', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    renderWith(<ThemeSwitcher />);
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('on "system" it follows the OS live; an explicit choice ignores the OS', () => {
    renderWith(<ThemeSwitcher />);
    systemDark = true;
    act(() => mqListeners.forEach((l) => l()));
    expect(isDarkNow()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(mqListeners).toHaveLength(0); // listener removed
    systemDark = false;
    act(() => mqListeners.forEach((l) => l()));
    expect(isDarkNow()).toBe(false);
  });
  it('works when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderWith(<ThemeSwitcher />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Dark' }))).not.toThrow();
    expect(isDarkNow()).toBe(true);
    vi.restoreAllMocks();
  });
  it('is labelled in Ukrainian too', () => {
    renderWith(<ThemeSwitcher />, { locale: 'uk' });
    expect(screen.getByRole('group', { name: 'Тема' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Темна' })).toBeInTheDocument();
  });
});
