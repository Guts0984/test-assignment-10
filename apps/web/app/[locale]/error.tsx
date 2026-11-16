'use client';
import { useTranslations } from 'next-intl';
import { Button } from '@/shared/ui';

export default function Error({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('common');
  return (
    <div className="grid gap-3">
      <p>{t('error')}</p>
      <Button className="w-fit" onClick={reset}>
        {t('retry')}
      </Button>
    </div>
  );
}
