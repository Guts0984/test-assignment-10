'use client';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { PRODUCT_SORTS } from '@shop/shared';
import { useCategories } from '@/entities/product';
import { usePathname, useRouter } from '@/shared/i18n/navigation';
import { useDebouncedValue } from '@/shared/lib/use-debounced-value';
import { Button, Field, Input } from '@/shared/ui';
import { Select } from '@/shared/ui/input';
import {
  catalogToApiFilters,
  catalogToQuery,
  DEFAULT_CATALOG_STATE,
  parseCatalogParams,
  type CatalogUrlState,
} from '../model/url-state';

/**
 * Filters live in the URL: link-able, survive reload, and "Back" walks through them.
 * Selecting a category / sort pushes a history entry; typing (search, prices) replaces it after a pause.
 */
export function CatalogFilters() {
  const t = useTranslations('catalog');
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const categories = useCategories();
  const urlState = parseCatalogParams(sp);
  const urlKey = catalogToQuery(urlState);

  const [draft, setDraft] = useState<CatalogUrlState>(urlState);
  const lastPushed = useRef(urlKey);

  // URL changed from outside (Back / Forward / link): show it
  useEffect(() => {
    if (urlKey !== lastPushed.current) {
      lastPushed.current = urlKey;
      setDraft(parseCatalogParams(sp));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to URL changes
  }, [urlKey]);

  const debouncedText = useDebouncedValue(
    { q: draft.q, minPrice: draft.minPrice, maxPrice: draft.maxPrice },
    350,
  );
  useEffect(() => {
    const next = { ...parseCatalogParams(sp), ...debouncedText };
    const key = catalogToQuery(next);
    if (key !== lastPushed.current) {
      lastPushed.current = key;
      router.replace(`${pathname}${key}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only after the debounced text changes
  }, [debouncedText]);

  const pushNow = (patch: Partial<CatalogUrlState>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    const key = catalogToQuery(next);
    lastPushed.current = key;
    router.push(`${pathname}${key}`);
  };

  const { errors } = catalogToApiFilters(draft);

  return (
    <form
      role="search"
      aria-label={t('results')}
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
      onSubmit={(e) => e.preventDefault()}
    >
      <Field id="catalog-q" label={t('searchLabel')} className="lg:col-span-2">
        {(a11y) => (
          <Input
            {...a11y}
            type="search"
            value={draft.q}
            placeholder={t('searchPlaceholder')}
            onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          />
        )}
      </Field>
      <Field id="catalog-category" label={t('category')}>
        {(a11y) => (
          <Select
            {...a11y}
            value={draft.category}
            onChange={(e) => pushNow({ category: e.target.value })}
          >
            <option value="">{t('allCategories')}</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.slug}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        id="catalog-min"
        label={t('priceFrom')}
        error={errors.minPrice ? t('invalidPrice') : undefined}
      >
        {(a11y) => (
          <Input
            {...a11y}
            inputMode="decimal"
            value={draft.minPrice}
            onChange={(e) => setDraft({ ...draft, minPrice: e.target.value })}
          />
        )}
      </Field>
      <Field
        id="catalog-max"
        label={t('priceTo')}
        error={errors.maxPrice ? t('invalidPrice') : undefined}
      >
        {(a11y) => (
          <Input
            {...a11y}
            inputMode="decimal"
            value={draft.maxPrice}
            onChange={(e) => setDraft({ ...draft, maxPrice: e.target.value })}
          />
        )}
      </Field>
      <Field id="catalog-sort" label={t('sort')}>
        {(a11y) => (
          <Select
            {...a11y}
            value={draft.sort}
            onChange={(e) => pushNow({ sort: e.target.value as CatalogUrlState['sort'] })}
          >
            {PRODUCT_SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`sortOptions.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="flex items-end">
        <Button variant="outline" onClick={() => pushNow(DEFAULT_CATALOG_STATE)}>
          {t('reset')}
        </Button>
      </div>
    </form>
  );
}
