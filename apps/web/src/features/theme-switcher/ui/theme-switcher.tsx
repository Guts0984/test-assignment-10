'use client';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { cn } from '@/shared/lib/cn';
import { applyTheme, readStoredTheme, storeTheme, THEMES, type Theme } from '@/shared/lib/theme';

const ICON = { light: Sun, dark: Moon, system: Monitor } as const;

/** Light / dark / follow the system. The choice is remembered per browser. */
export function ThemeSwitcher() {
  const t = useTranslations('common.theme');
  const [theme, setTheme] = useState<Theme>('system');

  // read after mount: the server cannot know the stored choice (no hydration mismatch)
  useEffect(() => setTheme(readStoredTheme()), []);

  // while on "system", follow the OS switching between light and dark
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  function choose(next: Theme) {
    setTheme(next);
    storeTheme(next);
    applyTheme(next);
  }

  return (
    <div role="group" aria-label={t('label')} className="flex overflow-hidden rounded-md border">
      {THEMES.map((value) => {
        const Icon = ICON[value];
        return (
          <button
            key={value}
            type="button"
            aria-pressed={value === theme}
            aria-label={t(value)}
            title={t(value)}
            className={cn(
              'px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              value === theme
                ? 'bg-primary text-primary-foreground'
                : 'bg-background hover:bg-accent',
            )}
            onClick={() => choose(value)}
          >
            <Icon aria-hidden className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
