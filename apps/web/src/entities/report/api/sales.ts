import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SalesReport } from '@shop/shared';
import { apiFetch } from '@/shared/api/client';
import { toQueryString } from '@/shared/lib/query-string';

export const useSalesReport = (period: { from: string; to: string } | null) =>
  useQuery({
    queryKey: ['sales', period],
    queryFn: () => apiFetch<SalesReport>(`/reports/sales${toQueryString(period ?? {})}`),
    enabled: period !== null,
    placeholderData: keepPreviousData,
  });
