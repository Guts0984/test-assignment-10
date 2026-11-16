'use client';
import { useLocale, useTranslations } from 'next-intl';
import { StockLabel, useProduct } from '@/entities/product';
import { AddToCartButton } from '@/features/add-to-cart';
import type { Locale } from '@/shared/config/locales';
import { isApiError } from '@/shared/api/client';
import { Link } from '@/shared/i18n/navigation';
import { formatMoney } from '@/shared/lib/format';
import { Alert, Badge, Card, CardContent, Skeleton } from '@/shared/ui';

export function ProductPage({ id }: { id: string }) {
  const t = useTranslations('catalog');
  const tc = useTranslations('common');
  const locale = useLocale() as Locale;
  const q = useProduct(id);

  const back = (
    <Link href="/" className="text-sm underline">
      ← {t('backToCatalog')}
    </Link>
  );

  if (q.isPending) return <Skeleton className="h-60" />;
  if (q.isError) {
    const missing = isApiError(q.error) && [400, 404, 422].includes(q.error.status);
    return (
      <div className="grid gap-4">
        {back}
        <Alert tone={missing ? 'warning' : 'danger'}>
          {missing ? t('productNotFound') : tc('error')}
        </Alert>
      </div>
    );
  }
  const p = q.data;
  return (
    <div className="grid gap-4">
      {back}
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:pt-6">
          <p className="text-sm text-muted-foreground">
            {t('categoryLabel')}: {p.categoryName}
          </p>
          <h1 className="text-2xl font-bold">{p.name}</h1>
          <p className="text-3xl font-semibold">{formatMoney(p.price, locale)}</p>
          <StockLabel stock={p.stock} />
          {!p.active ? <Badge tone="warning">{t('hiddenNotice')}</Badge> : null}
          <div>
            <AddToCartButton product={p} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
