import { PRODUCT_SORTS, type ProductSort } from '@shop/shared';
import type { ProductFilters } from '@/entities/product';
import { parseMoneyInput } from '@/shared/lib/format';
import { toQueryString } from '@/shared/lib/query-string';

/** The catalogue filters exactly as they appear in the URL (prices in ₴ as typed). */
export type CatalogUrlState = {
  q: string;
  category: string;
  minPrice: string;
  maxPrice: string;
  sort: ProductSort;
};

export const DEFAULT_CATALOG_STATE: CatalogUrlState = {
  q: '',
  category: '',
  minPrice: '',
  maxPrice: '',
  sort: 'newest',
};

type Params = { get(name: string): string | null };

/** Removes control characters (NUL, line breaks, tabs, DEL) - they can only come from a crafted link. */
export const stripControlChars = (s: string): string =>
  [...s].filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('');

export function parseCatalogParams(sp: Params): CatalogUrlState {
  const sort = sp.get('sort');
  return {
    // control characters (NUL, newlines...) can only come from a crafted link, never from typing
    q: stripControlChars(sp.get('q') ?? '').slice(0, 100),
    category: sp.get('category') ?? '',
    minPrice: sp.get('minPrice') ?? '',
    maxPrice: sp.get('maxPrice') ?? '',
    sort: (PRODUCT_SORTS as readonly string[]).includes(sort ?? '')
      ? (sort as ProductSort)
      : 'newest',
  };
}

/** "?q=..&sort=.." - defaults are omitted so the default view has a clean URL. */
export function catalogToQuery(s: CatalogUrlState): string {
  return toQueryString({
    q: s.q.trim() || undefined,
    category: s.category || undefined,
    minPrice: s.minPrice.trim() || undefined,
    maxPrice: s.maxPrice.trim() || undefined,
    sort: s.sort === 'newest' ? undefined : s.sort,
  });
}

export type CatalogParse = {
  filters: ProductFilters;
  errors: { minPrice?: true; maxPrice?: true; range?: true };
};

/** URL state -> API filters (₴ -> kopecks). Unparseable prices are reported and ignored, never sent. */
export function catalogToApiFilters(s: CatalogUrlState): CatalogParse {
  const errors: CatalogParse['errors'] = {};
  let minPrice: number | undefined;
  let maxPrice: number | undefined;
  if (s.minPrice.trim()) {
    const v = parseMoneyInput(s.minPrice);
    if (v === null) errors.minPrice = true;
    else minPrice = v;
  }
  if (s.maxPrice.trim()) {
    const v = parseMoneyInput(s.maxPrice);
    if (v === null) errors.maxPrice = true;
    else maxPrice = v;
  }
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    errors.range = true;
    minPrice = undefined;
    maxPrice = undefined;
  }
  return {
    filters: {
      q: s.q.trim() || undefined,
      category: s.category || undefined,
      minPrice,
      maxPrice,
      sort: s.sort,
    },
    errors,
  };
}
