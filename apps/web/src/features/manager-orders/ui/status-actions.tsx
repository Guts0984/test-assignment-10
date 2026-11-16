'use client';
import { useTranslations } from 'next-intl';
import type { OrderStatus } from '@shop/shared';
import { useChangeOrderStatus } from '@/entities/order';
import { isApiError } from '@/shared/api/client';
import { Button } from '@/shared/ui';

/** "Shipped" for paid orders, "Delivered" for shipped ones; nothing otherwise. */
export function StatusActions({ id, status }: { id: string; status: OrderStatus }) {
  const t = useTranslations('manager.orders');
  const change = useChangeOrderStatus();
  const target = status === 'paid' ? 'shipped' : status === 'shipped' ? 'delivered' : null;
  if (!target) return <span className="text-muted-foreground">{t('noActions')}</span>;
  return (
    <div className="grid gap-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={change.isPending}
        onClick={() => change.mutate({ id, status: target })}
      >
        {target === 'shipped' ? t('markShipped') : t('markDelivered')}
      </Button>
      {isApiError(change.error) && change.error.status === 409 ? (
        <p className="text-xs text-destructive">{t('invalidTransition')}</p>
      ) : null}
    </div>
  );
}
