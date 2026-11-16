import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CartDto } from '@shop/shared';
import { apiFetch } from '@/shared/api/client';

export const cartKey = ['cart'] as const;

export function useCart(enabled = true) {
  return useQuery({
    queryKey: cartKey,
    queryFn: () => apiFetch<CartDto>('/cart'),
    enabled,
    staleTime: 0,
  });
}

/** Every cart mutation answers with the fresh cart: put it straight into the cache. */
function useCartMutation<V>(fn: (v: V) => Promise<CartDto>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (cart) => qc.setQueryData(cartKey, cart),
  });
}

export const usePutCartItem = () =>
  useCartMutation(({ productId, qty }: { productId: string; qty: number }) =>
    apiFetch<CartDto>(`/cart/items/${productId}`, { method: 'PUT', body: { qty } }),
  );
export const useRemoveCartItem = () =>
  useCartMutation((productId: string) =>
    apiFetch<CartDto>(`/cart/items/${productId}`, { method: 'DELETE' }),
  );
export const useAcceptPrices = () =>
  useCartMutation(() => apiFetch<CartDto>('/cart/accept-prices', { method: 'POST', body: {} }));
export const useApplyPromo = () =>
  useCartMutation((code: string) =>
    apiFetch<CartDto>('/cart/promo', { method: 'POST', body: { code } }),
  );
export const useRemovePromo = () =>
  useCartMutation(() => apiFetch<CartDto>('/cart/promo', { method: 'DELETE' }));
