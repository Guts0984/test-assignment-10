'use client';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { useOrder } from '@/entities/order';
import { useMe } from '@/entities/session';
import { isApiError } from '@/shared/api/client';
import { usePathname, useRouter } from '@/shared/i18n/navigation';
import { Alert, Skeleton } from '@/shared/ui';
import { OrderDetails } from '@/widgets/order-details';

export function OrderPage({ id }: { id: string }) {
  const t = useTranslations('orders');
  const tc = useTranslations('common');
  const me = useMe();
  const order = useOrder(id);
  const router = useRouter();
  const pathname = usePathname();
  const visitor = me.isSuccess && me.data === null;
  // a link to an order (e-mail, bookmark) opened without a session: sign in first, then come back
  useEffect(() => {
    if (visitor) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [visitor, router, pathname]);
  if (visitor || order.isPending || me.isPending) return <Skeleton className="h-60" />;
  if (order.isError) {
    if (isApiError(order.error) && order.error.status === 401)
      return <Alert tone="warning">{t('loadError')}</Alert>;
    return (
      <Alert tone={isApiError(order.error) && order.error.status === 404 ? 'warning' : 'danger'}>
        {isApiError(order.error) && order.error.status === 404 ? tc('notFound') : t('loadError')}
      </Alert>
    );
  }
  return <OrderDetails order={order.data} isOwnerCustomer={me.data?.role === 'customer'} />;
}
