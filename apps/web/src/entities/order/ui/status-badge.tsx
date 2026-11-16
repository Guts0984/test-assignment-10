import { useTranslations } from 'next-intl';
import type { OrderStatus } from '@shop/shared';
import { Badge } from '@/shared/ui';

const TONE: Record<OrderStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  awaiting_payment: 'warning',
  paid: 'info',
  shipped: 'info',
  delivered: 'success',
  cancelled: 'danger',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const t = useTranslations('orders.statuses');
  return <Badge tone={TONE[status]}>{t(status)}</Badge>;
}
