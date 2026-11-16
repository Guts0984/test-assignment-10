import { and, eq, ne } from 'drizzle-orm';
import { reserveStock, releaseStock, schema, type Tx } from '@shop/db';
import { type WebhookEvent } from '@shop/shared';
import { type AppCtx } from '../ctx';
import {
  findPromoByCode,
  redeemPromo,
  customerUsedPromo,
  toPromoRecord,
} from '../promos/promo-store';
import { validatePromo } from '@shop/shared';
import { addEvent, createRefund, type OrderRow } from '../orders/order-support';

const { payments, paymentEvents, orders, orderItems, refunds } = schema;

export type WebhookResult =
  | { status: 'processed'; outcome: string }
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: string };

/**
 * Applies one provider notification. Safe to call any number of times, in any order, concurrently:
 *  - idempotency: payment_events.event_id is inserted first; a second delivery inserts nothing
 *    and returns early. It is in the SAME transaction as the state change, so a crash in between
 *    leaves no half-processed event behind.
 *  - the ORDER row is locked first (same lock cancel/expire/status take), which serialises
 *    "payment arrives" against "customer cancels" / "reservation expires".
 */
export async function processWebhook(ctx: AppCtx, event: WebhookEvent): Promise<WebhookResult> {
  return ctx.db.transaction(async (tx) => {
    const orderRows = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, event.orderId))
      .for('update')
      .limit(1);
    const order = orderRows[0];
    if (!order) return { status: 'ignored', reason: 'unknown_order' } as const;

    const inserted = await tx
      .insert(paymentEvents)
      .values({ eventId: event.eventId, type: event.type, receivedAt: ctx.clock.now() })
      .onConflictDoNothing()
      .returning({ eventId: paymentEvents.eventId });
    if (inserted.length === 0) return { status: 'duplicate' } as const;

    if (event.type === 'refund.succeeded') return applyRefundSucceeded(tx, ctx, order, event);

    const paymentRows = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, event.paymentId))
      .for('update')
      .limit(1);
    const payment = paymentRows[0];
    if (!payment || payment.orderId !== order.id)
      return { status: 'ignored', reason: 'unknown_payment' } as const;
    if (payment.amount !== event.amount)
      return { status: 'ignored', reason: 'amount_mismatch' } as const;

    return event.type === 'payment.failed'
      ? applyPaymentFailed(tx, ctx, order, payment)
      : applyPaymentSucceeded(tx, ctx, order, payment);
  });
}

type PaymentRow = typeof payments.$inferSelect;

async function applyPaymentFailed(
  tx: Tx,
  ctx: AppCtx,
  order: OrderRow,
  payment: PaymentRow,
): Promise<WebhookResult> {
  if (payment.status !== 'pending') return { status: 'processed', outcome: 'already_final' };
  const now = ctx.clock.now();
  await tx
    .update(payments)
    .set({ status: 'failed', completedAt: now })
    .where(eq(payments.id, payment.id));
  if (order.status === 'awaiting_payment')
    await addEvent(tx, order.id, 'payment_failed', now, { amount: payment.amount });
  return { status: 'processed', outcome: 'payment_failed' };
}

async function applyPaymentSucceeded(
  tx: Tx,
  ctx: AppCtx,
  order: OrderRow,
  payment: PaymentRow,
): Promise<WebhookResult> {
  // a second notification for a payment we already booked (with a NEW event id) must not pay twice
  if (payment.status === 'succeeded') return { status: 'processed', outcome: 'already_paid' };
  const now = ctx.clock.now();
  await tx
    .update(payments)
    .set({ status: 'succeeded', completedAt: now })
    .where(eq(payments.id, payment.id));

  if (order.status === 'awaiting_payment') {
    await markPaid(tx, order, now);
    await addEvent(tx, order.id, 'paid', now, { amount: payment.amount });
    return { status: 'processed', outcome: 'paid' };
  }

  if (order.status === 'cancelled') {
    // A cancelled order that already holds ANOTHER successful payment (the one the cancellation
    // refunded, or an earlier late payment) has had its own money handled: this payment is extra
    // money for the same order. It goes back in full, as a duplicate. (Booking it as a normal refund
    // would push refunded_total above the order total - a CHECK violation, a 500 and no refund.)
    const other = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.orderId, order.id),
          eq(payments.status, 'succeeded'),
          ne(payments.id, payment.id),
        ),
      )
      .limit(1);
    if (other[0]) {
      await createRefund(tx, ctx, {
        order,
        paymentId: payment.id,
        amount: payment.amount,
        kind: 'duplicate_payment',
      });
      await addEvent(tx, order.id, 'duplicate_payment_refunded', now, { amount: payment.amount });
      return { status: 'processed', outcome: 'duplicate_refunded' };
    }
    // customer cancelled on purpose: the money goes back, the order stays cancelled
    if (order.cancelReason !== 'expired') {
      await createRefund(tx, ctx, {
        order,
        paymentId: payment.id,
        amount: payment.amount,
        kind: 'late_payment',
      });
      await addEvent(tx, order.id, 'auto_refunded_late_payment', now, {
        amount: payment.amount,
        reason: 'order_was_cancelled',
      });
      return { status: 'processed', outcome: 'refunded_cancelled_order' };
    }
    // reservation expired: restore the order if the goods are still there
    const items = await tx
      .select({ productId: orderItems.productId, qty: orderItems.qty })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));
    const reserved = await reserveStock(tx, items);
    if (reserved.ok) {
      const promoOk = await reacquirePromo(tx, ctx, order, now);
      if (promoOk) {
        await tx
          .update(orders)
          .set({ cancelReason: null, cancelledAt: null })
          .where(eq(orders.id, order.id));
        await markPaid(tx, order, now);
        await addEvent(tx, order.id, 'restored_after_late_payment', now, {
          amount: payment.amount,
        });
        return { status: 'processed', outcome: 'restored' };
      }
      await releaseStock(tx, items); // promo gone: we cannot honour the price, give the stock back
    }
    await createRefund(tx, ctx, {
      order,
      paymentId: payment.id,
      amount: payment.amount,
      kind: 'late_payment',
    });
    await addEvent(tx, order.id, 'auto_refunded_late_payment', now, {
      amount: payment.amount,
      reason: reserved.ok ? 'promo_unavailable' : 'out_of_stock',
      ...(reserved.ok ? {} : { shortages: reserved.shortages }),
    });
    return { status: 'processed', outcome: 'refunded_out_of_stock' };
  }

  // already paid / shipped / delivered: this is a SECOND payment for the same order -> give it back
  await createRefund(tx, ctx, {
    order,
    paymentId: payment.id,
    amount: payment.amount,
    kind: 'duplicate_payment',
  });
  await addEvent(tx, order.id, 'duplicate_payment_refunded', now, { amount: payment.amount });
  return { status: 'processed', outcome: 'duplicate_refunded' };
}

async function markPaid(tx: Tx, order: OrderRow, now: Date): Promise<void> {
  await tx
    .update(orders)
    .set({ status: 'paid', paidAt: now, reservedUntil: null })
    .where(eq(orders.id, order.id));
}

/** Restoring an expired order needs its promo use back (the use was released on expiry). */
async function reacquirePromo(tx: Tx, ctx: AppCtx, order: OrderRow, now: Date): Promise<boolean> {
  if (!order.promoId || !order.promoCode) return true;
  const promo = await findPromoByCode(tx, order.promoCode, { lock: true });
  if (!promo) return false;
  const check = validatePromo(toPromoRecord(promo), {
    now,
    // the discount was already given; only the usage rules matter, not the minimum or the dates
    subtotal: Number.MAX_SAFE_INTEGER,
    customerAlreadyUsed: await customerUsedPromo(tx, promo.id, order.userId),
  });
  const blocked =
    !check.ok &&
    (check.reason === 'limit_reached' ||
      check.reason === 'already_used' ||
      check.reason === 'not_found' ||
      check.reason === 'inactive');
  if (blocked) return false;
  return redeemPromo(tx, promo, order.userId, order.id, now);
}

async function applyRefundSucceeded(
  tx: Tx,
  ctx: AppCtx,
  order: OrderRow,
  event: Extract<WebhookEvent, { type: 'refund.succeeded' }>,
): Promise<WebhookResult> {
  const rows = await tx
    .select()
    .from(refunds)
    .where(eq(refunds.id, event.refundId))
    .for('update')
    .limit(1);
  const refund = rows[0];
  if (!refund || refund.orderId !== order.id)
    return { status: 'ignored', reason: 'unknown_refund' };
  if (refund.amount !== event.amount) return { status: 'ignored', reason: 'amount_mismatch' };
  if (refund.status === 'succeeded') return { status: 'processed', outcome: 'already_refunded' };
  const now = ctx.clock.now();
  await tx
    .update(refunds)
    .set({ status: 'succeeded', completedAt: now })
    .where(eq(refunds.id, refund.id));
  await addEvent(tx, order.id, 'refund_succeeded', now, {
    amount: refund.amount,
    kind: refund.kind,
  });
  return { status: 'processed', outcome: 'refunded' };
}
