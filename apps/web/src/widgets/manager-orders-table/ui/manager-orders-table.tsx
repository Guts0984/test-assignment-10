'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ORDER_STATUSES, type OrderStatus } from '@shop/shared';
import { OrderStatusBadge, useOrders, type OrderFilters } from '@/entities/order';
import { StatusActions } from '@/features/manager-orders';
import type { Locale } from '@/shared/config/locales';
import { Link, usePathname, useRouter } from '@/shared/i18n/navigation';
import { formatDateTime, formatMoney } from '@/shared/lib/format';
import { toQueryString } from '@/shared/lib/query-string';
import { useDebouncedValue } from '@/shared/lib/use-debounced-value';
import { Alert, Button, Field, Input, Table, TBody, TD, TH, THead, TR } from '@/shared/ui';
import { Select } from '@/shared/ui/input';

const isStatus = (v: string | null): v is OrderStatus =>
  !!v && (ORDER_STATUSES as readonly string[]).includes(v);
const isDay = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Filters (status, period, search) live in the URL; the table follows the URL. */
export function ManagerOrdersTable() {
  const t = useTranslations('manager.orders');
  const to = useTranslations('orders');
  const tc = useTranslations('common');
  const tv = useTranslations('validation');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const urlFilters: OrderFilters = {
    status: isStatus(sp.get('status')) ? (sp.get('status') as OrderStatus) : undefined,
    from: isDay(sp.get('from')) ? sp.get('from')! : undefined,
    to: isDay(sp.get('to')) ? sp.get('to')! : undefined,
    q: sp.get('q')?.slice(0, 100) || undefined,
  };
  const rangeInvalid = Boolean(urlFilters.from && urlFilters.to && urlFilters.from > urlFilters.to);
  const effective = rangeInvalid ? { ...urlFilters, from: undefined, to: undefined } : urlFilters;
  const orders = useOrders(effective);
  const rows = orders.data?.pages.flatMap((p) => p.items) ?? [];

  const urlQ = urlFilters.q ?? '';
  const [q, setQ] = useState(urlQ);
  useEffect(() => setQ(urlQ), [urlQ]);
  const debouncedQ = useDebouncedValue(q, 350);
  const go = (patch: Partial<OrderFilters>, replace = false) => {
    const next = { ...urlFilters, ...patch };
    const url = `${pathname}${toQueryString({ status: next.status, from: next.from, to: next.to, q: next.q })}`;
    if (replace) router.replace(url);
    else router.push(url);
  };
  useEffect(() => {
    if ((debouncedQ || undefined) !== (urlFilters.q || undefined))
      go({ q: debouncedQ || undefined }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only after the debounced text changes
  }, [debouncedQ]);

  return (
    <div className="grid gap-4">
      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        role="search"
        onSubmit={(e) => e.preventDefault()}
      >
        <Field id="mo-q" label={tc('search')}>
          {(a) => (
            <Input
              {...a}
              type="search"
              placeholder={t('searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
        </Field>
        <Field id="mo-status" label={tc('status')}>
          {(a) => (
            <Select
              {...a}
              value={urlFilters.status ?? ''}
              onChange={(e) =>
                go({ status: (e.target.value || undefined) as OrderStatus | undefined })
              }
            >
              <option value="">{tc('all')}</option>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {to(`statuses.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="mo-from" label={tc('from')}>
          {(a) => (
            <Input
              {...a}
              type="date"
              value={urlFilters.from ?? ''}
              onChange={(e) => go({ from: e.target.value || undefined })}
            />
          )}
        </Field>
        <Field id="mo-to" label={tc('to')} error={rangeInvalid ? tv('dateOrder') : undefined}>
          {(a) => (
            <Input
              {...a}
              type="date"
              value={urlFilters.to ?? ''}
              onChange={(e) => go({ to: e.target.value || undefined })}
            />
          )}
        </Field>
      </form>
      {orders.isError ? <Alert tone="danger">{tc('error')}</Alert> : null}
      <Table aria-busy={orders.isFetching}>
        <THead>
          <TR>
            <TH>{to('number')}</TH>
            <TH>{tc('customer')}</TH>
            <TH>{tc('date')}</TH>
            <TH>{tc('status')}</TH>
            <TH className="text-right">{tc('total')}</TH>
            <TH>{tc('actions')}</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((o) => (
            <TR key={o.id} data-testid="manager-order-row">
              <TD>
                <Link className="font-medium underline" href={`/orders/${o.id}`}>
                  {o.number}
                </Link>
              </TD>
              <TD>{o.customerEmail}</TD>
              <TD>{formatDateTime(o.createdAt, locale)}</TD>
              <TD>
                <OrderStatusBadge status={o.status} />
              </TD>
              <TD className="text-right">{formatMoney(o.total, locale)}</TD>
              <TD>
                <StatusActions id={o.id} status={o.status} />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {!orders.isPending && rows.length === 0 ? (
        <p className="text-muted-foreground">{tc('empty')}</p>
      ) : null}
      {orders.hasNextPage ? (
        <Button
          variant="outline"
          onClick={() => void orders.fetchNextPage()}
          disabled={orders.isFetchingNextPage}
        >
          {tc('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
