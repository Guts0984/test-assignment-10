import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PromoCreate, PromoDto } from '@shop/shared';
import { apiFetch } from '@/shared/api/client';

export const promosKey = ['promos'] as const;

export const usePromos = () =>
  useQuery({ queryKey: promosKey, queryFn: () => apiFetch<PromoDto[]>('/promos') });

export function useCreatePromo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PromoCreate) => apiFetch<PromoDto>('/promos', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: promosKey }),
  });
}

export function useUpdatePromo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Pick<PromoDto, 'active'>> }) =>
      apiFetch<PromoDto>(`/promos/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: promosKey }),
  });
}
