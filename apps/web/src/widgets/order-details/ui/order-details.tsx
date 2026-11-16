'use client';
import { useLocale, useTranslations } from 'next-intl';
import type { OrderDto } from '@shop/shared';
import { OrderStatusBadge, OrderTimeline } from '@/entities/order';
import { CancelButton } from '@/features/cancel-order';
import { PayButton } from '@/features/pay-order';
import { ReturnForm } from '@/features/return-items';
import type { Locale } from '@/shared/config/locales';
import { formatCountdown, secondsLeft } from '@/shared/lib/countdown';
import { formatDateTime, formatMoney } from '@/shared/lib/format';
import { useNow } from '@/shared/lib/use-now';
import {
  Alert,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/shared/ui';

/** Reservation countdown: ticks every second, no polling of its own. */
function ReservationTimer({ until }: { until: string }) {
  const t = useTranslations('orders');
  const now = useNow(1000);
  const left = secondsLeft(until, now);
  return left > 0 ? (
    <p className="text-sm" data-testid="reservation-timer">
      {t('reservedUntil')} <strong className="tabular-nums">{formatCountdown(left)}</strong>
    </p>
  ) : (
    <p className="text-sm text-destructive">{t('reservationExpired')}</p>
  );
}

export function OrderDetails({
  order,
  isOwnerCustomer,
}: {
  order: OrderDto;
  isOwnerCustomer: boolean;
}) {
  const t = useTranslations('orders');
  const locale = useLocale() as Locale;
  const money = (v: number) => formatMoney(v, locale);
  const canReturn =
    isOwnerCustomer &&
    order.status === 'delivered' &&
    order.returnableUntil !== null &&
    new Date(order.returnableUntil) > new Date();

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold" data-testid="order-number">
          {t('number')} {order.number}
        </h1>
        <span data-testid="order-status">
          <OrderStatusBadge status={order.status} />
        </span>
        <span className="text-sm text-muted-foreground">
          {formatDateTime(order.createdAt, locale)}
        </span>
      </div>

      {order.status === 'cancelled' && order.cancelReason ? (
        <p className="text-sm text-muted-foreground">{t(`cancelReason.${order.cancelReason}`)}</p>
      ) : null}

      {order.status === 'awaiting_payment' ? (
        <Card>
          <CardContent className="grid gap-4 pt-4 sm:pt-6">
            {order.reservedUntil ? <ReservationTimer until={order.reservedUntil} /> : null}
            {isOwnerCustomer ? (
              <>
                <PayButton orderId={order.id} />
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {t('waitingPayment')}
                </p>
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('items')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Table>
            <THead>
              <TR>
                <TH>{t('items')}</TH>
                <TH className="text-right">{t('quantityShort', { count: '' }).trim() || '#'}</TH>
                <TH className="text-right">{t('total')}</TH>
              </TR>
            </THead>
            <TBody>
              {order.items.map((i) => (
                <TR key={i.id}>
                  <TD>
                    {i.name}
                    <div className="text-xs text-muted-foreground">
                      {money(i.unitPrice)} × {i.qty}
                      {i.returnedQty > 0
                        ? ` · ${t('return.bought', { count: i.qty, returned: i.returnedQty })}`
                        : ''}
                    </div>
                  </TD>
                  <TD className="text-right">{t('quantityShort', { count: i.qty })}</TD>
                  <TD className="text-right">{money(i.net)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <dl className="grid gap-1 text-sm sm:ml-auto sm:min-w-64">
            <div className="flex justify-between">
              <dt>{t('subtotal')}</dt>
              <dd>{money(order.subtotal)}</dd>
            </div>
            {order.discount > 0 ? (
              <div className="flex justify-between text-success-foreground">
                <dt>
                  {order.promoCode ? t('discount', { code: order.promoCode }) : t('discountPlain')}
                </dt>
                <dd>−{money(order.discount)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between">
              <dt>
                {t('delivery')} ({t(`deliveryMethod.${order.deliveryMethod}`)})
              </dt>
              <dd>{money(order.delivery)}</dd>
            </div>
            <div className="flex justify-between border-t pt-1 text-base font-semibold">
              <dt>{t('total')}</dt>
              <dd data-testid="order-total">{money(order.total)}</dd>
            </div>
            {order.refundedTotal > 0 ? (
              <div className="flex justify-between text-muted-foreground">
                <dt>{t('refundedTotal')}</dt>
                <dd data-testid="order-refunded">{money(order.refundedTotal)}</dd>
              </div>
            ) : null}
          </dl>
          {order.address ? (
            <p className="text-sm">
              <strong>{t('address')}:</strong> {order.address.fullName}, {order.address.phone},{' '}
              {order.address.postalCode} {order.address.city}, {order.address.street}{' '}
              {order.address.building}
              {order.address.apartment ? `/${order.address.apartment}` : ''}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {order.refunds.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('refunds')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2 text-sm" data-testid="refunds">
              {order.refunds.map((r) => (
                <li key={r.id}>
                  <strong>
                    {t('refundLine', {
                      amount: money(r.amount),
                      status: t(`refundStatus.${r.status}`),
                    })}
                  </strong>
                  <span className="text-muted-foreground">
                    {' '}
                    · {t(`refundKind.${r.kind}`)} ·{' '}
                    {formatDateTime(r.completedAt ?? r.createdAt, locale)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {isOwnerCustomer && (order.status === 'awaiting_payment' || order.status === 'paid') ? (
        <CancelButton orderId={order.id} />
      ) : null}

      {canReturn ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('return.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ReturnForm order={order} />
          </CardContent>
        </Card>
      ) : order.status === 'delivered' && isOwnerCustomer ? (
        <Alert tone="info">{t('return.closed')}</Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('history')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div data-testid="order-history">
            <OrderTimeline events={order.events} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
