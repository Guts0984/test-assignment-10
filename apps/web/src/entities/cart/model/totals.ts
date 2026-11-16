import type { CartDto, DeliveryMethod } from '@shop/shared';

export type DisplayTotals = {
  subtotal: number;
  discount: number;
  afterDiscount: number;
  delivery: number;
  total: number;
};

/**
 * The totals the customer sees. Money rules live on the server (and in @shop/shared); the cart DTO
 * already carries subtotal / discount / per-method delivery, so the screen only ADDS them up: what
 * you see is what the server will charge.
 */
export function displayTotals(
  cart: Pick<CartDto, 'subtotal' | 'discount' | 'afterDiscount' | 'delivery'>,
  method: DeliveryMethod,
): DisplayTotals {
  const delivery = cart.delivery[method] ?? 0;
  return {
    subtotal: cart.subtotal,
    discount: cart.discount,
    afterDiscount: cart.afterDiscount,
    delivery,
    total: cart.afterDiscount + delivery,
  };
}

export const cartItemCount = (cart: Pick<CartDto, 'lines'> | undefined): number =>
  cart ? cart.lines.reduce((n, l) => n + l.qty, 0) : 0;

/** True when checkout must not proceed until the customer acts in the cart. */
export const cartBlocksCheckout = (
  cart: Pick<CartDto, 'lines' | 'hasPriceChanges' | 'hasStockProblems'>,
): boolean => cart.lines.length === 0 || cart.hasPriceChanges || cart.hasStockProblems;
