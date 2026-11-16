'use client';
import { CreditCard } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { usePayOrder } from '@/entities/order';
import { Alert, Button } from '@/shared/ui';

/**
 * Opens the payment stub in a NEW tab and keeps this tab on the order: the order page polls and shows
 * "paid" by itself. The tab is opened synchronously (inside the click) so pop-up blockers allow it.
 */
export function PayButton({ orderId }: { orderId: string }) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const pay = usePayOrder(orderId);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  const start = () => {
    const tab = window.open('about:blank', '_blank');
    pay.mutate(`/${locale}/orders/${orderId}`, {
      onSuccess: ({ url }) => {
        if (tab) tab.location.href = url;
        else setFallbackUrl(url);
      },
      onError: () => tab?.close(),
    });
  };

  return (
    <div className="grid gap-2">
      <Button size="lg" onClick={start} disabled={pay.isPending}>
        <CreditCard aria-hidden className="h-4 w-4" />
        {pay.isPending ? t('paying') : t('payNow')}
      </Button>
      <p className="text-xs text-muted-foreground">{t('payHint')}</p>
      {fallbackUrl ? (
        <Alert tone="warning">
          {t('popupBlocked')}{' '}
          <a className="font-medium underline" href={fallbackUrl} target="_blank" rel="noreferrer">
            {t('openPayment')}
          </a>
        </Alert>
      ) : null}
    </div>
  );
}
