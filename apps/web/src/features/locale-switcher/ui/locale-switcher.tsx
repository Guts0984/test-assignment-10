'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { LOCALES } from '@/shared/config/locales';
import { usePathname, useRouter } from '@/shared/i18n/navigation';
import { cn } from '@/shared/lib/cn';

const LABEL: Record<string, string> = { uk: 'UA', en: 'EN' };

/** Switches the language and keeps the page and its query string (filters) intact. */
export function LocaleSwitcher() {
  const t = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const qs = sp.toString();
  return (
    <div role="group" aria-label={t('language')} className="flex overflow-hidden rounded-md border">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === locale}
          className={cn(
            'px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            l === locale ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-accent',
          )}
          onClick={() => router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { locale: l })}
        >
          {LABEL[l]}
        </button>
      ))}
    </div>
  );
}
