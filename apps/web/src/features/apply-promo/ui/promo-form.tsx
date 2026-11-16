'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import type { CartDto } from '@shop/shared';
import { PromoReasonText, useApplyPromo, useRemovePromo } from '@/entities/cart';
import { isApiError } from '@/shared/api/client';
import type { Locale } from '@/shared/config/locales';
import { formatMoney } from '@/shared/lib/format';
import { Alert, Button, Input, Label } from '@/shared/ui';

export function PromoForm({ promo }: { promo: CartDto['promo'] }) {
  const t = useTranslations('cart');
  const locale = useLocale() as Locale;
  const apply = useApplyPromo();
  const remove = useRemovePromo();
  const [code, setCode] = useState('');

  const rejection =
    isApiError(apply.error) && apply.error.code === 'promo_rejected'
      ? (apply.error.details as { reason: string; minOrder: number | null })
      : null;

  return (
    <div className="grid gap-2">
      <Label htmlFor="promo-code">{t('promoLabel')}</Label>
      {promo ? (
        <div className="grid gap-2">
          {promo.valid ? (
            <Alert tone="success">
              {t('promoApplied', {
                code: promo.code,
                discount: formatMoney(promo.discount, locale),
              })}
            </Alert>
          ) : (
            <Alert tone="warning">
              {t('promoInvalidNow', { code: promo.code })}:{' '}
              <PromoReasonText reason={promo.reason ?? 'not_found'} minOrder={promo.minOrder} />
            </Alert>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            {t('promoRemove')}
          </Button>
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) apply.mutate(code.trim(), { onSuccess: () => setCode('') });
          }}
        >
          <Input
            id="promo-code"
            value={code}
            placeholder={t('promoPlaceholder')}
            autoComplete="off"
            aria-invalid={Boolean(rejection)}
            aria-describedby={rejection ? 'promo-error' : undefined}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={apply.isPending || !code.trim()}>
            {t('promoApply')}
          </Button>
        </form>
      )}
      {rejection ? (
        <p id="promo-error" role="alert" className="text-sm text-destructive">
          <PromoReasonText reason={rejection.reason} minOrder={rejection.minOrder} />
        </p>
      ) : null}
    </div>
  );
}
