import { useLocale, useTranslations } from 'next-intl';
import { PROMO_REJECT_REASONS, type PromoRejectReason } from '@shop/shared';
import type { Locale } from '@/shared/config/locales';
import { formatMoney } from '@/shared/lib/format';

const isReason = (r: string): r is PromoRejectReason =>
  (PROMO_REJECT_REASONS as readonly string[]).includes(r);

/** A human reason why a promo code was refused ("expired", "minimum order 500 ₴", "already used" ...). */
export function PromoReasonText({
  reason,
  minOrder,
}: {
  reason: string;
  minOrder?: number | null;
}) {
  const t = useTranslations('cart.promoReasons');
  const locale = useLocale() as Locale;
  if (!isReason(reason)) return <>{t('not_found')}</>;
  return <>{t(reason, { minOrder: formatMoney(minOrder ?? 0, locale) })}</>;
}
