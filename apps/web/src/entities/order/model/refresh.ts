import type { OrderDto } from '@shop/shared';

/**
 * How often an open order page asks the server again (ms), or false to stop.
 * It polls while something can still change WITHOUT the customer doing anything:
 * waiting for payment (also a late notification), an unfinished payment session, a refund in progress.
 */
export function orderRefetchInterval(
  order: Pick<OrderDto, 'status' | 'pendingPayment' | 'refunds'> | undefined,
): number | false {
  if (!order) return false;
  if (order.status === 'awaiting_payment') return 1500;
  if (order.pendingPayment) return 2000;
  if (order.refunds.some((r) => r.status === 'pending')) return 2000;
  return false;
}
