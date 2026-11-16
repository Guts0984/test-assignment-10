'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLocale, useTranslations } from 'next-intl';
import { useRef } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { CartDto, OrderDto } from '@shop/shared';
import { displayTotals, TotalsList, useAcceptPrices } from '@/entities/cart';
import { useCreateOrder } from '@/entities/order';
import { isApiError } from '@/shared/api/client';
import type { Locale } from '@/shared/config/locales';
import { formatMoney } from '@/shared/lib/format';
import { Alert, Button, Field, Input } from '@/shared/ui';
import {
  checkoutFormSchema,
  EMPTY_CHECKOUT_FORM,
  toOrderCreate,
  type CheckoutFormValues,
} from '../model/schema';

type FieldName = Exclude<keyof CheckoutFormValues, 'deliveryMethod'>;
const FIELDS: { name: FieldName; label: string; autoComplete: string; type?: string }[] = [
  { name: 'fullName', label: 'fullName', autoComplete: 'name' },
  { name: 'phone', label: 'phone', autoComplete: 'tel', type: 'tel' },
  { name: 'city', label: 'city', autoComplete: 'address-level2' },
  { name: 'street', label: 'street', autoComplete: 'address-line1' },
  { name: 'building', label: 'building', autoComplete: 'off' },
  { name: 'apartment', label: 'apartment', autoComplete: 'off' },
  { name: 'postalCode', label: 'postalCode', autoComplete: 'postal-code' },
];

export function CheckoutForm({
  cart,
  onCreated,
}: {
  cart: CartDto;
  onCreated: (order: OrderDto) => void;
}) {
  const t = useTranslations('checkout');
  const tv = useTranslations('validation');
  const locale = useLocale() as Locale;
  const create = useCreateOrder();
  const accept = useAcceptPrices();
  // ONE key per checkout screen: a double click or a retry after a dropped connection re-sends it,
  // and the server answers with the order that already exists.
  const idempotencyKey = useRef(crypto.randomUUID());

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<CheckoutFormValues>({
    resolver: zodResolver(checkoutFormSchema),
    defaultValues: EMPTY_CHECKOUT_FORM,
  });
  const method = useWatch({ control, name: 'deliveryMethod' });
  const totals = displayTotals(cart, method);

  const submit = (v: CheckoutFormValues) => {
    if (create.isPending) return;
    create.mutate(
      { body: toOrderCreate(v, totals.total), key: idempotencyKey.current },
      { onSuccess: onCreated },
    );
  };

  const err = create.error;
  const apiErr = isApiError(err) ? err : null;
  const details = (apiErr?.details ?? {}) as {
    shortages?: { productId: string; name: string; requested: number; available: number }[];
    changes?: { productId: string; name: string; oldPrice: number; newPrice: number }[];
  };
  const errCode = apiErr ? apiErr.code : null;
  const known = [
    'insufficient_stock',
    'price_changed',
    'total_mismatch',
    'promo_rejected',
    'cart_empty',
    'conflict',
    'validation_error',
  ];

  return (
    <form
      noValidate
      className="grid gap-6"
      onSubmit={handleSubmit(submit)}
      aria-describedby={err ? 'checkout-error' : undefined}
    >
      {err ? (
        <Alert tone="danger" id="checkout-error">
          <p className="font-medium">
            {errCode && known.includes(errCode)
              ? t(`errors.${errCode}` as 'errors.generic')
              : apiErr?.status === 0
                ? t('errors.generic')
                : t('errors.generic')}
          </p>
          {details.shortages ? (
            <ul className="mt-2 list-disc pl-5">
              {details.shortages.map((s) => (
                <li key={s.productId}>
                  {t('errors.shortage', {
                    name: s.name,
                    requested: s.requested,
                    available: s.available,
                  })}
                </li>
              ))}
            </ul>
          ) : null}
          {details.changes ? (
            <>
              <ul className="mt-2 list-disc pl-5">
                {details.changes.map((c) => (
                  <li key={c.productId}>
                    {t('errors.priceChange', {
                      name: c.name,
                      oldPrice: formatMoney(c.oldPrice, locale),
                      newPrice: formatMoney(c.newPrice, locale),
                    })}
                  </li>
                ))}
              </ul>
              <Button
                className="mt-3"
                variant="outline"
                size="sm"
                disabled={accept.isPending}
                onClick={() => accept.mutate(undefined, { onSuccess: () => create.reset() })}
              >
                {t('confirmPricesRetry')}
              </Button>
            </>
          ) : null}
        </Alert>
      ) : null}

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('delivery')}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" value="pickup" {...register('deliveryMethod')} />
          {t('pickup')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" value="courier" {...register('deliveryMethod')} />
          {cart.delivery.courier === 0
            ? t('courierFree')
            : t('courierPrice', { price: formatMoney(cart.delivery.courier, locale) })}
        </label>
      </fieldset>

      {method === 'courier' ? (
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium">{t('address')}</legend>
          {FIELDS.map((f) => (
            <Field
              key={f.name}
              id={`addr-${f.name}`}
              label={t(f.label as 'fullName')}
              error={
                errors[f.name]?.message ? tv(errors[f.name]!.message as 'required') : undefined
              }
              className={f.name === 'street' ? 'sm:col-span-2' : undefined}
            >
              {(a11y) => (
                <Input
                  {...a11y}
                  type={f.type ?? 'text'}
                  autoComplete={f.autoComplete}
                  {...register(f.name)}
                />
              )}
            </Field>
          ))}
        </fieldset>
      ) : null}

      <section aria-label={t('summary')} className="grid gap-2 rounded-lg border p-4">
        <h2 className="font-semibold">{t('summary')}</h2>
        <TotalsList totals={totals} />
      </section>
      <p className="text-sm text-muted-foreground">{t('reserveNote', { minutes: 15 })}</p>
      <Button type="submit" size="lg" disabled={create.isPending}>
        {create.isPending ? t('placing') : t('placeOrder')}
      </Button>
    </form>
  );
}
