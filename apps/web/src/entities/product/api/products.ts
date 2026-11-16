import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Page, ProductDto, ProductSort } from '@shop/shared';
import { apiFetch, isApiError } from '@/shared/api/client';
import { toQueryString } from '@/shared/lib/query-string';

export type ProductFilters = {
  q?: string;
  category?: string;
  /** kopecks */
  minPrice?: number;
  /** kopecks */
  maxPrice?: number;
  sort?: ProductSort;
  includeInactive?: boolean;
};

export const productsKey = (f: ProductFilters) => ['products', f] as const;

export function useProducts(filters: ProductFilters, pageSize = 24) {
  return useInfiniteQuery({
    queryKey: productsKey(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch<Page<ProductDto>>(
        `/products${toQueryString({ ...filters, limit: pageSize, cursor: pageParam, includeInactive: filters.includeInactive ? 'true' : undefined })}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export type Category = { id: string; name: string; slug: string };

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => apiFetch<Category[]>('/categories'),
    staleTime: 5 * 60_000,
  });
}

export const productKey = (id: string) => ['product', id] as const;

export function useProduct(id: string) {
  return useQuery({
    queryKey: productKey(id),
    queryFn: () => apiFetch<ProductDto>(`/products/${encodeURIComponent(id)}`),
    retry: (count, err) => !(isApiError(err) && err.status >= 400 && err.status < 500) && count < 2,
  });
}
