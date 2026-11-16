'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { StubOutcome } from '@shop/shared';
import { apiFetch, isApiError } from '@/shared/api/client';
import type { Locale } from '@/shared/config/locales';
import { formatMoney } from '@/shared/lib/format';
import { safeReturnUrl } from '@/shared/lib/safe-redirect';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@/shared/ui';

type Session = {
  paymentId: string;
  orderId: string;
  orderNumber: string;
  amount: number;
  status: string;
};

/**
 * The payment provider's page (a stub). The three buttons decide how the payment ends; the "provider"
 * then notifies the shop with a signed webhook - the order page in the other tab updates by itself.
 */
export function StubPayPage({ paymentId }: { paymentId: string }) {
  const t = useTranslations('stub');
  const tc = useTranslations('common');
  const locale = useLocale() as Locale;
  const returnUrl = safeReturnUrl(useSearchParams().get('returnUrl'));
  const [outcome, setOutcome] = useState<StubOutcome | null>(null);
  const session = useQuery({
    queryKey: ['stub', paymentId],
    queryFn: () => apiFetch<Session>(`/stub/payments/${paymentId}`),
    retry: false,
  });
  const complete = useMutation({
    mutationFn: (o: StubOutcome) =>
      apiFetch<{ delivered: boolean }>(`/stub/payments/${paymentId}/complete`, {
        method: 'POST',
        body: { outcome: o },
      }),
    onSuccess: (_r, o) => setOutcome(o),
  });

  return (
    <div className="mx-auto max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {session.isPending ? <Skeleton className="h-20" /> : null}
          {session.isError ? (
            <Alert tone="danger">
              {isApiError(session.error) && session.error.status === 404
                ? t('notFound')
                : tc('error')}
            </Alert>
          ) : null}
          {session.data ? (
            <>
              <p className="text-sm text-muted-foreground">{t('intro')}</p>
              <p className="font-medium">{t('order', { number: session.data.orderNumber })}</p>
              <p className="text-lg font-semibold">
                {t('amount', { amount: formatMoney(session.data.amount, locale) })}
              </p>
              {outcome ? (
                <Alert tone={outcome === 'failure' ? 'danger' : 'success'}>
                  {outcome === 'success'
                    ? t('doneSuccess')
                    : outcome === 'failure'
                      ? t('doneFailure')
                      : t('doneDelayed')}
                </Alert>
              ) : null}
              {complete.isError ? <Alert tone="danger">{tc('error')}</Alert> : null}
              <div className="grid gap-2">
                <Button disabled={complete.isPending} onClick={() => complete.mutate('success')}>
                  {t('success')}
                </Button>
                <Button
                  variant="destructive"
                  disabled={complete.isPending}
                  onClick={() => complete.mutate('failure')}
                >
                  {t('failure')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={complete.isPending}
                  onClick={() => complete.mutate('success_delayed')}
                >
                  {t('delayed')}
                </Button>
              </div>
              {outcome && returnUrl ? (
                <a className="text-sm font-medium underline" href={returnUrl}>
                  {t('backToOrder')}
                </a>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
