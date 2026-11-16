'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useCancelOrder } from '@/entities/order';
import { Alert, Button } from '@/shared/ui';

/** Two-step cancel (button -> inline confirmation): no accidental cancellations, no browser dialogs. */
export function CancelButton({ orderId }: { orderId: string }) {
  const t = useTranslations('orders');
  const tc = useTranslations('common');
  const cancel = useCancelOrder(orderId);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button variant="outline" onClick={() => setConfirming(true)}>
        {t('cancelOrder')}
      </Button>
    );
  }
  return (
    <Alert tone="warning" className="grid gap-3">
      <p>{t('confirmCancel')}</p>
      {cancel.isError ? <p className="text-destructive">{tc('error')}</p> : null}
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(undefined, { onSettled: () => setConfirming(false) })}
        >
          {t('confirmCancelYes')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setConfirming(false)}>
          {tc('no')}
        </Button>
      </div>
    </Alert>
  );
}
