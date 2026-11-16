import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProductCreate, ProductDto, ProductUpdate } from '@shop/shared';
import { apiFetch } from '@/shared/api/client';

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProductCreate) =>
      apiFetch<ProductDto>('/products', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['products'] }),
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ProductUpdate }) =>
      apiFetch<ProductDto>(`/products/${id}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['products'] }),
  });
}
