'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { usePromos, useUpdatePromo } from '@/entities/promo';
import { NewPromoForm } from '@/features/manager-promos';
import type { Locale } from '@/shared/config/locales';
import { formatDateTime, formatMoney } from '@/shared/lib/format';
import { Alert, Badge, Button, Skeleton, Table, TBody, TD, TH, THead, TR } from '@/shared/ui';
import { RequireRole } from '@/widgets/require-role';

function PromosTable() {
  const t = useTranslations('manager.promos');
  const tc = useTranslations('common');
  const locale = useLocale() as Locale;
  const promos = usePromos();
  const update = useUpdatePromo();
  const [creating, setCreating] = useState(false);
  return (
    <div className="grid gap-4">
      <Button className="w-fit" onClick={() => setCreating(true)}>
        {t('new')}
      </Button>
      {creating ? <NewPromoForm onDone={() => setCreating(false)} /> : null}
      {promos.isPending ? <Skeleton className="h-24" /> : null}
      {promos.isError ? <Alert tone="danger">{tc('error')}</Alert> : null}
      {promos.data ? (
        <Table>
          <THead>
            <TR>
              <TH>{t('code')}</TH>
              <TH>{t('value')}</TH>
              <TH>{t('minOrder')}</TH>
              <TH>{t('expiresAt')}</TH>
              <TH className="text-right">{t('used')}</TH>
              <TH>{tc('status')}</TH>
            </TR>
          </THead>
          <TBody>
            {promos.data.map((p) => (
              <TR key={p.id} data-testid="promo-row">
                <TD className="font-mono font-medium">{p.code}</TD>
                <TD>{p.type === 'percent' ? `${p.value}%` : formatMoney(p.value, locale)}</TD>
                <TD>{p.minOrder > 0 ? formatMoney(p.minOrder, locale) : '—'}</TD>
                <TD>{p.expiresAt ? formatDateTime(p.expiresAt, locale) : '—'}</TD>
                <TD className="text-right" data-testid="promo-used">
                  {p.used} / {p.maxUses ?? t('unlimited')}
                </TD>
                <TD>
                  <div className="flex items-center gap-2">
                    <Badge tone={p.active ? 'success' : 'neutral'}>
                      {p.active ? tc('active') : tc('inactive')}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ id: p.id, body: { active: !p.active } })}
                    >
                      {p.active ? tc('inactive') : tc('active')}
                    </Button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : null}
    </div>
  );
}

export function ManagerPromosPage() {
  const t = useTranslations('manager.promos');
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <RequireRole role="manager">
        <PromosTable />
      </RequireRole>
    </div>
  );
}
