'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from '@/shared/i18n/navigation';
import { Button, Field, Input } from '@/shared/ui';
import { lastDays, type Period } from '../model/period';

/** The period lives in the URL (?from=..&to=..): shareable, reload-safe, Back works. */
export function PeriodPicker({ period, valid }: { period: Period; valid: boolean }) {
  const t = useTranslations('manager.reports');
  const tc = useTranslations('common');
  const router = useRouter();
  const pathname = usePathname();
  const [draft, setDraft] = useState(period);
  useEffect(() => setDraft(period), [period.from, period.to]); // eslint-disable-line react-hooks/exhaustive-deps -- follows the URL

  const go = (p: Period) => router.push(`${pathname}?from=${p.from}&to=${p.to}`);
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      aria-label={t('period')}
      onSubmit={(e) => {
        e.preventDefault();
        go(draft);
      }}
    >
      <Field id="rep-from" label={tc('from')}>
        {(a) => (
          <Input
            {...a}
            type="date"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        )}
      </Field>
      <Field id="rep-to" label={tc('to')}>
        {(a) => (
          <Input
            {...a}
            type="date"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
        )}
      </Field>
      <Button type="submit">{t('apply')}</Button>
      {[7, 30, 90].map((d) => (
        <Button key={d} variant="outline" size="sm" onClick={() => go(lastDays(d, new Date()))}>
          {t(`last${d}` as 'last7')}
        </Button>
      ))}
      {!valid ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {t('invalidPeriod')}
        </p>
      ) : null}
    </form>
  );
}
