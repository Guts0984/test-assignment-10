'use client';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ProductDto } from '@shop/shared';
import { useProducts, useUpdateProduct } from '@/entities/product';
import { ProductForm } from '@/features/manager-products';
import type { Locale } from '@/shared/config/locales';
import { formatMoney } from '@/shared/lib/format';
import { useDebouncedValue } from '@/shared/lib/use-debounced-value';
import { Badge, Button, Field, Input, Table, TBody, TD, TH, THead, TR } from '@/shared/ui';

function StockEditor({ product }: { product: ProductDto }) {
  const t = useTranslations('manager.products');
  const update = useUpdateProduct();
  const [value, setValue] = useState(String(product.stock));
  const valid = /^\d{1,7}$/.test(value);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && Number(value) !== product.stock)
          update.mutate({ id: product.id, body: { stockDelta: Number(value) - product.stock } });
      }}
    >
      <Input
        aria-label={`${t('stock')}: ${product.name}`}
        aria-invalid={!valid}
        className="w-24"
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        disabled={!valid || update.isPending || Number(value) === product.stock}
      >
        {t('saveStock')}
      </Button>
    </form>
  );
}

export function ManagerProductsTable() {
  const t = useTranslations('manager.products');
  const tc = useTranslations('common');
  const locale = useLocale() as Locale;
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search, 300);
  const [editing, setEditing] = useState<ProductDto | 'new' | null>(null);
  const products = useProducts({ q: q || undefined, includeInactive: true, sort: 'newest' }, 30);
  const toggle = useUpdateProduct();
  const rows = products.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field id="mp-search" label={tc('search')}>
          {(a) => (
            <Input
              {...a}
              type="search"
              placeholder={t('searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
        </Field>
        <Button onClick={() => setEditing('new')}>{t('new')}</Button>
      </div>
      {editing ? (
        <ProductForm
          key={editing === 'new' ? 'new' : editing.id}
          product={editing === 'new' ? undefined : editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
      <Table aria-busy={products.isFetching}>
        <THead>
          <TR>
            <TH>{t('name')}</TH>
            <TH>{t('category')}</TH>
            <TH className="text-right">{t('price')}</TH>
            <TH>{t('stock')}</TH>
            <TH>{tc('status')}</TH>
            <TH>{tc('actions')}</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((p) => (
            <TR key={p.id} data-testid="manager-product-row">
              <TD className="font-medium">{p.name}</TD>
              <TD>{p.categoryName}</TD>
              <TD className="text-right">{formatMoney(p.price, locale)}</TD>
              <TD>
                <StockEditor key={`${p.id}-${p.stock}`} product={p} />
              </TD>
              <TD>
                <Badge tone={p.active ? 'success' : 'neutral'}>
                  {p.active ? tc('active') : tc('inactive')}
                </Badge>
              </TD>
              <TD>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                    {tc('edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate({ id: p.id, body: { active: !p.active } })}
                  >
                    {p.active ? t('hide') : t('show')}
                  </Button>
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {!products.isPending && rows.length === 0 ? (
        <p className="text-muted-foreground">{tc('empty')}</p>
      ) : null}
      {products.hasNextPage ? (
        <Button
          variant="outline"
          onClick={() => void products.fetchNextPage()}
          disabled={products.isFetchingNextPage}
        >
          {tc('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
