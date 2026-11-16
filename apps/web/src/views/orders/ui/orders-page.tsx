'use client';
import { useLocale, useTranslations } from 'next-intl';
import { OrderStatusBadge, useOrders } from '@/entities/order';
import type { Locale } from '@/shared/config/locales';
import { Link } from '@/shared/i18n/navigation';
import { formatDateTime, formatMoney } from '@/shared/lib/format';
import { Alert, Button, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/shared/ui';
import { RequireRole } from '@/widgets/require-role';

function OrdersList() {
  const t = useTranslations('orders');
  const tc = useTranslations('common');
  const locale = useLocale() as Locale;
  const orders = useOrders({});
  const rows = orders.data?.pages.flatMap((p) => p.items) ?? [];
  if (orders.isPending) return <Skeleton className="h-32" />;
  if (orders.isError) return <Alert tone="danger">{tc('error')}</Alert>;
  if (rows.length === 0) return <p>{t('empty')}</p>;
  return (
    <div className="grid gap-4">
      <Table>
        <THead>
          <TR>
            <TH>{t('number')}</TH>
            <TH>{t('created')}</TH>
            <TH>{tc('status')}</TH>
            <TH className="text-right">{t('total')}</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((o) => (
            <TR key={o.id} data-testid="order-row">
              <TD>
                <Link className="font-medium underline" href={`/orders/${o.id}`}>
                  {o.number}
                </Link>
              </TD>
              <TD>{formatDateTime(o.createdAt, locale)}</TD>
              <TD>
                <OrderStatusBadge status={o.status} />
              </TD>
              <TD className="text-right">{formatMoney(o.total, locale)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {orders.hasNextPage ? (
        <Button
          variant="outline"
          className="w-fit"
          onClick={() => void orders.fetchNextPage()}
          disabled={orders.isFetchingNextPage}
        >
          {tc('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

export function OrdersPage() {
  const t = useTranslations('orders');
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <RequireRole role="customer">
        <OrdersList />
      </RequireRole>
    </div>
  );
}
