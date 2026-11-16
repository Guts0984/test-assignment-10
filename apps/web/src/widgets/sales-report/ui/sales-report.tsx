'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useSalesReport } from '@/entities/report';
import { PeriodPicker, periodFromParams } from '@/features/report-period';
import type { Locale } from '@/shared/config/locales';
import { formatMoney } from '@/shared/lib/format';
import {
  Alert,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/shared/ui';

export function SalesReport() {
  const t = useTranslations('manager.reports');
  const tc = useTranslations('common');
  const locale = useLocale() as Locale;
  const sp = useSearchParams();
  const { period, valid } = periodFromParams(sp, new Date());
  const report = useSalesReport(period);
  const data = report.data;
  const maxDay = Math.max(1, ...(data?.byDay.map((d) => d.revenue) ?? [1]));

  return (
    <div className="grid gap-6">
      <PeriodPicker period={period} valid={valid} />
      {report.isError ? <Alert tone="danger">{tc('error')}</Alert> : null}
      {!data ? (
        <Skeleton className="h-32" />
      ) : (
        <div aria-busy={report.isFetching} className="grid gap-6">
          <dl className="grid gap-4 sm:grid-cols-3">
            <Kpi
              label={t('revenue')}
              value={formatMoney(data.netRevenue, locale)}
              testId="kpi-revenue"
            />
            <Kpi label={t('orders')} value={String(data.orders)} testId="kpi-orders" />
            <Kpi
              label={t('average')}
              value={formatMoney(data.averageCheck, locale)}
              testId="kpi-average"
            />
          </dl>
          <Card>
            <CardHeader>
              <CardTitle>{t('top')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <THead>
                  <TR>
                    <TH>#</TH>
                    <TH>{t('top')}</TH>
                    <TH className="text-right">{t('units')}</TH>
                    <TH className="text-right">{tc('total')}</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.topProducts.map((p, i) => (
                    <TR key={p.productId}>
                      <TD>{i + 1}</TD>
                      <TD>{p.name}</TD>
                      <TD className="text-right">{p.units}</TD>
                      <TD className="text-right">{formatMoney(p.revenue, locale)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('byDay')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-1" aria-label={t('byDay')}>
                {data.byDay.map((d) => (
                  <li
                    key={d.day}
                    className="grid grid-cols-[6.5rem_1fr_8rem] items-center gap-2 text-xs"
                  >
                    <time dateTime={d.day}>{d.day}</time>
                    <div className="h-3 rounded bg-secondary" aria-hidden>
                      <div
                        className="h-3 rounded bg-primary"
                        style={{ width: `${Math.max(2, (d.revenue / maxDay) * 100)}%` }}
                      />
                    </div>
                    <span className="text-right">{formatMoney(d.revenue, locale)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <Card>
      <CardContent className="pt-4 sm:pt-6">
        <dt className="text-sm text-muted-foreground">{label}</dt>
        <dd className="text-2xl font-semibold" data-testid={testId}>
          {value}
        </dd>
      </CardContent>
    </Card>
  );
}
