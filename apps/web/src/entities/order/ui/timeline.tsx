import { useLocale, useTranslations } from 'next-intl';
import type { OrderEventDto } from '@shop/shared';
import type { Locale } from '@/shared/config/locales';
import { formatDateTime, formatMoney } from '@/shared/lib/format';

const KNOWN = new Set([
  'created',
  'payment_failed',
  'paid',
  'restored_after_late_payment',
  'auto_refunded_late_payment',
  'duplicate_payment_refunded',
  'cancelled',
  'expired',
  'shipped',
  'delivered',
  'return_requested',
  'refund_requested',
  'refund_succeeded',
]);

/** Order history: created, paid, shipped, returns, refunds - including the automatic outcomes of late payments. */
export function OrderTimeline({ events }: { events: OrderEventDto[] }) {
  const t = useTranslations('orders');
  const locale = useLocale() as Locale;
  return (
    <ol className="grid gap-3" aria-label={t('history')}>
      {events.map((e) => {
        const amount = typeof e.data.amount === 'number' ? formatMoney(e.data.amount, locale) : '';
        const reason = typeof e.data.reason === 'string' ? e.data.reason : null;
        return (
          <li key={e.id} className="grid grid-cols-[auto_1fr] gap-x-3">
            <span aria-hidden className="mt-1.5 h-2.5 w-2.5 rounded-full bg-primary" />
            <div>
              <p className="text-sm font-medium">
                {KNOWN.has(e.type) ? t(`events.${e.type}` as 'events.created', { amount }) : e.type}
              </p>
              {reason ? (
                <p className="text-xs text-muted-foreground">
                  {t(`eventDetails.reason_${reason}` as 'eventDetails.reason_out_of_stock')}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                <time dateTime={e.createdAt}>{formatDateTime(e.createdAt, locale)}</time>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
