import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { enqueueJob, schema, type Executor, type Tx } from '@shop/db';
import { type OrderEventType, type RefundDto } from '@shop/shared';
import { type AppCtx } from '../ctx';
import { notFound } from '../http/errors';

const { orders, orderEvents, refunds, payments } = schema;

export type OrderRow = typeof orders.$inferSelect;

export const formatOrderNumber = (n: number) => `ORD-${n}`;

export async function addEvent(
  ex: Executor,
  orderId: string,
  type: OrderEventType,
  at: Date,
  data: Record<string, unknown> = {},
): Promise<void> {
  await ex.insert(orderEvents).values({ orderId, type, data, createdAt: at });
}

/** Locks the order row. Every state change in the system starts here: it is the single serialisation point. */
export async function lockOrder(tx: Tx, orderId: string): Promise<OrderRow> {
  const rows = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update').limit(1);
  if (!rows[0]) throw notFound('Order not found');
  return rows[0];
}

export type RefundKind = RefundDto['kind'];

/**
 * Records a refund and asks the payment stub to execute it. The stub answers with a signed
 * `refund.succeeded` notification (job `deliver_webhook`), exactly like a real provider would.
 * Money that belongs to the order itself (cancellation / return / late payment on a cancelled order)
 * is added to orders.refunded_total; a refund of a DUPLICATE payment does not touch the order's books.
 */
export async function createRefund(
  tx: Tx,
  ctx: AppCtx,
  o: { order: OrderRow; paymentId: string; amount: number; kind: RefundKind; returnId?: string },
): Promise<string | null> {
  if (o.amount <= 0) return null;
  const now = ctx.clock.now();
  const [refund] = await tx
    .insert(refunds)
    .values({
      orderId: o.order.id,
      paymentId: o.paymentId,
      returnId: o.returnId ?? null,
      amount: o.amount,
      kind: o.kind,
      status: 'pending',
      createdAt: now,
    })
    .returning({ id: refunds.id });
  if (o.kind !== 'duplicate_payment') {
    await tx
      .update(orders)
      .set({ refundedTotal: sql`${orders.refundedTotal} + ${o.amount}` })
      .where(eq(orders.id, o.order.id));
  }
  await addEvent(tx, o.order.id, 'refund_requested', now, { amount: o.amount, kind: o.kind });
  await enqueueJob(tx, {
    type: 'deliver_webhook',
    runAt: now,
    payload: {
      eventId: randomUUID(),
      type: 'refund.succeeded',
      refundId: refund!.id,
      paymentId: o.paymentId,
      orderId: o.order.id,
      amount: o.amount,
      occurredAt: now.toISOString(),
    },
  });
  return refund!.id;
}

export async function findSucceededPayment(ex: Executor, orderId: string) {
  const rows = await ex
    .select()
    .from(payments)
    .where(sql`${payments.orderId} = ${orderId} AND ${payments.status} = 'succeeded'`)
    .orderBy(payments.completedAt)
    .limit(1);
  return rows[0] ?? null;
}
