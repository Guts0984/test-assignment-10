import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { enqueueJob, schema } from '@shop/db';
import { type PayResponse, type StubOutcome, type WebhookEvent } from '@shop/shared';
import { type AppCtx } from '../ctx';
import { AppError, conflict, notFound } from '../http/errors';
import { SIGNATURE_HEADER, signPayload } from './signature';

const { payments, orders } = schema;

/** Same input -> same id, so a re-clicked button re-sends the SAME event (the receiver must dedupe). */
export function deterministicUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** POST /orders/:id/pay - opens a payment session at the "provider" and returns its page URL. */
export async function startPayment(
  ctx: AppCtx,
  orderId: string,
  userId: string,
  returnUrl?: string,
): Promise<PayResponse> {
  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update')
      .limit(1);
    const order = rows[0];
    if (!order || order.userId !== userId) throw notFound('Order not found');
    if (order.status !== 'awaiting_payment')
      throw conflict('conflict', `Order is ${order.status}, it cannot be paid`);
    const now = ctx.clock.now();
    if (order.reservedUntil && order.reservedUntil <= now)
      throw conflict('conflict', 'The reservation has expired');
    const pending = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, 'pending')))
      .limit(1);
    let paymentId = pending[0]?.id;
    if (!paymentId) {
      const [p] = await tx
        .insert(payments)
        .values({ orderId, amount: order.total, status: 'pending', createdAt: now })
        .returning({ id: payments.id });
      paymentId = p!.id;
    }
    const url = new URL(`/stub/pay/${paymentId}`, ctx.env.PUBLIC_WEB_URL);
    if (returnUrl) url.searchParams.set('returnUrl', returnUrl);
    return { paymentId, url: url.toString() };
  });
}

export async function getStubSession(ctx: AppCtx, paymentId: string) {
  const rows = await ctx.db
    .select({
      id: payments.id,
      amount: payments.amount,
      status: payments.status,
      orderId: orders.id,
      number: orders.number,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (!rows[0]) throw notFound('Payment session not found');
  return {
    paymentId: rows[0].id,
    orderId: rows[0].orderId,
    orderNumber: `ORD-${rows[0].number}`,
    amount: rows[0].amount,
    status: rows[0].status,
  };
}

/**
 * The "provider" decides and notifies the shop by a SIGNED webhook, like a real one:
 *  - success / failure: notification is sent right away
 *  - success_delayed: it is queued and sent STUB_DELAY_SECONDS later (a late notification)
 * A failed delivery is retried by the job queue.
 */
export async function completeStubPayment(
  ctx: AppCtx,
  paymentId: string,
  outcome: StubOutcome,
): Promise<{ delivered: boolean; scheduledFor: string | null }> {
  const rows = await ctx.db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  const payment = rows[0];
  if (!payment) throw notFound('Payment session not found');
  const now = ctx.clock.now();
  const type = outcome === 'failure' ? 'payment.failed' : 'payment.succeeded';
  const event: WebhookEvent = {
    eventId: deterministicUuid(`${paymentId}:${type}`),
    type,
    paymentId,
    orderId: payment.orderId,
    amount: payment.amount,
    occurredAt: now.toISOString(),
  };
  if (outcome === 'success_delayed') {
    const runAt = new Date(now.getTime() + ctx.env.STUB_DELAY_SECONDS * 1000);
    await enqueueJob(ctx.db, { type: 'deliver_webhook', payload: event, runAt });
    return { delivered: false, scheduledFor: runAt.toISOString() };
  }
  try {
    await deliverWebhook(ctx, event);
  } catch {
    // the shop was unreachable: do what a provider does - retry later
    await enqueueJob(ctx.db, {
      type: 'deliver_webhook',
      payload: event,
      runAt: new Date(now.getTime() + 5000),
    });
    return { delivered: false, scheduledFor: new Date(now.getTime() + 5000).toISOString() };
  }
  return { delivered: true, scheduledFor: null };
}

/** HTTP POST of a signed event to the shop's webhook. Throws when the shop did not accept it (so the job is retried). */
export async function deliverWebhook(ctx: AppCtx, event: unknown): Promise<void> {
  const body = JSON.stringify(event);
  const res = await fetch(ctx.env.WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signPayload(ctx.env.WEBHOOK_SECRET, body, ctx.clock.now()),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status >= 500 || res.status === 429) throw new Error(`webhook answered ${res.status}`);
  if (res.status >= 400)
    throw new AppError(res.status, 'bad_signature', `webhook rejected the event (${res.status})`);
}

export const newEventId = () => randomUUID();
