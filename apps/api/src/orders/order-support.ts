import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
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
  // Books the refund against the order's own money - and refuses to go beyond what the order cost
  // (the table has a CHECK for the same invariant). A refund that does not fit is a CALCULATION BUG
  // in the caller; paying it out anyway would send money away under a wrong label, so it fails loudly:
  // the whole transaction rolls back, no refund row and no refund job are created.
  // The one legitimate "extra money" case - a second payment for the same order - is classified by
  // its caller (the payment webhook) and arrives here as `duplicate_payment`, which is not booked.
  const kind = o.kind;
  if (kind !== 'duplicate_payment') {
    const booked = await tx
      .update(orders)
      .set({ refundedTotal: sql`${orders.refundedTotal} + ${o.amount}` })
      .where(
        and(
          eq(orders.id, o.order.id),
          sql`${orders.refundedTotal} + ${o.amount} <= ${orders.total}`,
        ),
      )
      .returning({ id: orders.id });
    if (booked.length === 0)
      throw new Error(
        `refund of ${o.amount} (${kind}) exceeds what is left to refund on order ${o.order.id}`,
      );
  }
  const [refund] = await tx
    .insert(refunds)
    .values({
      orderId: o.order.id,
      paymentId: o.paymentId,
      returnId: o.returnId ?? null,
      amount: o.amount,
      kind,
      status: 'pending',
      createdAt: now,
    })
    .returning({ id: refunds.id });
  await addEvent(tx, o.order.id, 'refund_requested', now, { amount: o.amount, kind });
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
