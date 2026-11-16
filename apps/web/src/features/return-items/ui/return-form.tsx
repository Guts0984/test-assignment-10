'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import type { OrderDto } from '@shop/shared';
import { useCreateReturn } from '@/entities/order';
import { isApiError } from '@/shared/api/client';
import type { Locale } from '@/shared/config/locales';
import { formatDate, formatMoney } from '@/shared/lib/format';
import { Alert, Button, Field, Input } from '@/shared/ui';
import { Textarea } from '@/shared/ui/input';
import { buildReturn, estimateRefund, returnable } from '../model/estimate';

/** Partial return: pick items and quantities; shows the refund (discount share included) before sending. */
export function ReturnForm({ order }: { order: OrderDto }) {
  const t = useTranslations('orders.return');
  const tv = useTranslations('validation');
  const locale = useLocale() as Locale;
  const create = useCreateReturn(order.id);
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [done, setDone] = useState(false);

  const result = buildReturn(order.items, raw, reason);
  const estimate = estimateRefund(
    order.items,
    Object.fromEntries(
      order.items.map((i) => [i.id, Math.max(0, Math.floor(Number(raw[i.id] ?? 0) || 0))]),
    ),
  );
  const open = order.items.filter((i) => returnable(i) > 0);

  if (open.length === 0) return <p className="text-sm text-muted-foreground">{t('nothingLeft')}</p>;

  const apiErr = isApiError(create.error) ? create.error : null;
  const apiMessage = apiErr
    ? apiErr.code === 'return_exceeds_purchased' || apiErr.code === 'return_window_closed'
      ? t(`errors.${apiErr.code}`)
      : t('errors.generic')
    : null;

  return (
    <form
      noValidate
      className="grid gap-4"
      aria-label={t('title')}
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
        setDone(false);
        if (!result.ok) return;
        create.mutate(result.body, {
          onSuccess: () => {
            setRaw({});
            setReason('');
            setSubmitted(false);
            setDone(true);
          },
        });
      }}
    >
      {order.returnableUntil ? (
        <p className="text-sm text-muted-foreground">
          {t('deadline', { date: formatDate(order.returnableUntil, locale) })}
        </p>
      ) : null}
      <div className="grid gap-3">
        {open.map((i) => {
          const fieldError = submitted && !result.ok ? result.errors[i.id] : undefined;
          return (
            <Field
              key={i.id}
              id={`return-${i.id}`}
              label={t('qtyLabel', { name: i.name })}
              hint={t('bought', { count: i.qty, returned: i.returnedQty })}
              error={fieldError ? tv(fieldError) : undefined}
            >
              {(a11y) => (
                <Input
                  {...a11y}
                  className="w-28"
                  inputMode="numeric"
                  value={raw[i.id] ?? ''}
                  placeholder={`0–${returnable(i)}`}
                  onChange={(e) => setRaw({ ...raw, [i.id]: e.target.value })}
                />
              )}
            </Field>
          );
        })}
      </div>
      {submitted && !result.ok && result.none ? (
        <p role="alert" className="text-sm text-destructive">
          {tv('pickItems')}
        </p>
      ) : null}
      <Field id="return-reason" label={t('reason')}>
        {(a11y) => (
          <Textarea
            {...a11y}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </Field>
      <div className="rounded-lg border p-3 text-sm" aria-live="polite">
        <div className="flex justify-between font-medium">
          <span>{t('estimate')}</span>
          <span data-testid="return-estimate">{formatMoney(estimate, locale)}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t('estimateNote')}</p>
      </div>
      {apiMessage ? <Alert tone="danger">{apiMessage}</Alert> : null}
      {done ? <Alert tone="success">{t('success')}</Alert> : null}
      <Button type="submit" disabled={create.isPending}>
        {t('submit')}
      </Button>
    </form>
  );
}
