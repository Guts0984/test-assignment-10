'use client';
import { useTranslations } from 'next-intl';
import { CatalogFilters } from '@/features/catalog-filters';
import { ProductGrid } from '@/widgets/product-grid';

export function CatalogPage() {
  const t = useTranslations('catalog');
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <CatalogFilters />
      <ProductGrid />
    </div>
  );
}
