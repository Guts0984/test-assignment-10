import { useLocale, useTranslations } from 'next-intl';
import type { Locale } from '@/shared/config/locales';
import { formatMoney } from '@/shared/lib/format';
import type { DisplayTotals } from '../model/totals';

/** Subtotal, discount, delivery and total - the same numbers the server will charge. */
export function TotalsList({
  totals,
  deliveryPending = false,
}: {
  totals: DisplayTotals;
  deliveryPending?: boolean;
}) {
  const t = useTranslations('cart');
  const locale = useLocale() as Locale;
  return (
    <dl className="grid gap-1 text-sm" data-testid="totals">
      <div className="flex justify-between">
        <dt>{t('subtotal')}</dt>
        <dd data-testid="totals-subtotal">{formatMoney(totals.subtotal, locale)}</dd>
      </div>
      {totals.discount > 0 ? (
        <div className="flex justify-between text-green-800">
          <dt>{t('discount')}</dt>
          <dd data-testid="totals-discount">−{formatMoney(totals.discount, locale)}</dd>
        </div>
      ) : null}
      <div className="flex justify-between">
        <dt>{t('delivery')}</dt>
        <dd data-testid="totals-delivery">
          {deliveryPending
            ? '—'
            : totals.delivery === 0
              ? t('deliveryFree')
              : formatMoney(totals.delivery, locale)}
        </dd>
      </div>
      <div className="mt-1 flex justify-between border-t pt-2 text-base font-semibold">
        <dt>{t('total')}</dt>
        <dd data-testid="totals-total">
          {formatMoney(deliveryPending ? totals.afterDiscount : totals.total, locale)}
        </dd>
      </div>
    </dl>
  );
}
