import { calcReturnRefund, type OrderItemDto, type ReturnCreate } from '@shop/shared';

export type ReturnQuantities = Record<string, number>;

/** How many units of the line can still be returned. */
export const returnable = (i: Pick<OrderItemDto, 'qty' | 'returnedQty'>): number =>
  i.qty - i.returnedQty;

/** The refund the customer will get for the chosen quantities (discount share included, delivery excluded). */
export function estimateRefund(items: readonly OrderItemDto[], qty: ReturnQuantities): number {
  const lines = items
    .filter((i) => (qty[i.id] ?? 0) > 0 && (qty[i.id] ?? 0) <= returnable(i))
    .map((i) => ({
      net: i.net,
      qty: i.qty,
      alreadyReturned: i.returnedQty,
      returning: qty[i.id]!,
    }));
  return lines.length === 0 ? 0 : calcReturnRefund(lines).total;
}

/** Parses what was typed in the quantity fields; returns the payload or the first problem as a validation key. */
export function buildReturn(
  items: readonly OrderItemDto[],
  raw: Record<string, string>,
  reason: string,
):
  | { ok: true; body: ReturnCreate; qty: ReturnQuantities }
  | { ok: false; errors: Record<string, 'integer' | 'tooMany'>; none: boolean } {
  const errors: Record<string, 'integer' | 'tooMany'> = {};
  const qty: ReturnQuantities = {};
  for (const i of items) {
    const text = (raw[i.id] ?? '').trim();
    if (text === '') continue;
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0) errors[i.id] = 'integer';
    else if (n > returnable(i)) errors[i.id] = 'tooMany';
    else if (n > 0) qty[i.id] = n;
  }
  const none = Object.keys(qty).length === 0;
  if (Object.keys(errors).length > 0 || none)
    return { ok: false, errors, none: none && Object.keys(errors).length === 0 };
  return {
    ok: true,
    qty,
    body: {
      items: Object.entries(qty).map(([orderItemId, q]) => ({ orderItemId, qty: q })),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    },
  };
}
