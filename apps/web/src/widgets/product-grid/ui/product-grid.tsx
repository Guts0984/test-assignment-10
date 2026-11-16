'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { StockLabel, useProducts } from '@/entities/product';
import { AddToCartButton } from '@/features/add-to-cart';
import { catalogToApiFilters, parseCatalogParams } from '@/features/catalog-filters';
import type { Locale } from '@/shared/config/locales';
import { Link } from '@/shared/i18n/navigation';
import { formatMoney } from '@/shared/lib/format';
import { Alert, Button, Card, CardContent, Skeleton } from '@/shared/ui';

export function ProductGrid() {
  const t = useTranslations('catalog');
  const tc = useTranslations('common');
  const locale = useLocale() as Locale;
  const sp = useSearchParams();
  const { filters } = catalogToApiFilters(parseCatalogParams(sp));
  const q = useProducts(filters);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  if (q.isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
    );
  }
  if (q.isError) {
    return (
      <Alert tone="danger">
        {tc('error')}{' '}
        <Button variant="link" onClick={() => void q.refetch()}>
          {tc('retry')}
        </Button>
      </Alert>
    );
  }
  if (items.length === 0)
    return <p className="py-8 text-center text-muted-foreground">{t('noResults')}</p>;

  return (
    <div className="grid gap-4">
      <ul
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        aria-label={t('results')}
        aria-busy={q.isFetching}
      >
        {items.map((p) => (
          <li key={p.id}>
            <Card
              className="relative flex h-full flex-col hover:bg-accent/40"
              data-testid="product-card"
            >
              <CardContent className="flex flex-1 flex-col gap-2 pt-4 sm:pt-6">
                <p className="text-xs text-muted-foreground">{p.categoryName}</p>
                <h3 className="font-medium leading-snug">
                  <Link
                    href={`/products/${p.id}`}
                    className="after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {p.name}
                  </Link>
                </h3>
                <p className="text-lg font-semibold">{formatMoney(p.price, locale)}</p>
                <StockLabel stock={p.stock} />
                <div className="relative z-10 mt-auto pt-2">
                  <AddToCartButton product={p} />
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {q.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            {tc('loadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
