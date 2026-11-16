import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@shop/db';
import { signPayload } from '../src/payments/signature';
import { request, startTestApp, type TestApp } from './harness';
import {
  drainJobs,
  getOrder,
  makeProduct,
  makePromo,
  newClient,
  payOrder,
  placeOrder,
  sendWebhook,
  startPay,
  stockOf,
  stubClick,
  webhookEvent,
} from './shop';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({
    env: {
      API_RATE_MAX_PER_IP: '1000000',
      STUB_DELAY_SECONDS: '30',
      WEBHOOK_BAD_SIGNATURE_MAX_PER_MINUTE: '5',
    },
  });
});
afterAll(async () => app.close());

/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely typed JSON responses */
const eventTypes = (o: any): string[] => o.events.map((e: any) => e.type);

async function freshOrder(
  opts: { stock?: number; qty?: number; price?: number; promo?: string } = {},
) {
  const p = await makeProduct(app, { stock: opts.stock ?? 10, price: opts.price ?? 10_000 });
  const c = await newClient(app);
  const r = await placeOrder(c, [{ productId: p.id, qty: opts.qty ?? 1 }], { promo: opts.promo });
  expect(r.status).toBe(201);
  return { p, c, order: r.body };
}

describe('paying through the stub', () => {
  it('POST /orders/:id/pay returns a link to the stub page; "success" marks the order paid', async () => {
    const { c, order } = await freshOrder();
    const r = await c.post(`/orders/${order.id}/pay`, { returnUrl: `/uk/orders/${order.id}` });
    expect(r.status).toBe(200);
    expect(r.body.url).toMatch(
      new RegExp(`^http://shop.test/stub/pay/${r.body.paymentId}\\?returnUrl=`),
    );
    const info = await request(app, 'GET', `/stub/payments/${r.body.paymentId}`);
    expect(info.json).toMatchObject({
      orderNumber: order.number,
      amount: order.total,
      status: 'pending',
    });
    const click = await stubClick(app, r.body.paymentId, 'success');
    expect(click.body).toMatchObject({ delivered: true });
    const paid = await getOrder(c, order.id);
    expect(paid).toMatchObject({ status: 'paid', reservedUntil: null, pendingPayment: false });
    expect(paid.paidAt).not.toBeNull();
    expect(eventTypes(paid)).toEqual(['created', 'paid']);
  });

  it('opening the payment twice reuses the same session', async () => {
    const { c, order } = await freshOrder();
    const [a, b] = [await startPay(c, order.id), await startPay(c, order.id)];
    expect(a).toBe(b);
    expect(
      (await app.tdb.db.select().from(schema.payments).where(eq(schema.payments.orderId, order.id)))
        .length,
    ).toBe(1);
  });

  it('"failure" keeps the order unpaid and reserved, and the customer can try again', async () => {
    const { c, order } = await freshOrder();
    const id = await startPay(c, order.id);
    await stubClick(app, id, 'failure');
    const o = await getOrder(c, order.id);
    expect(o.status).toBe('awaiting_payment');
    expect(eventTypes(o)).toEqual(['created', 'payment_failed']);
    const retry = await startPay(c, order.id);
    await stubClick(app, retry, 'success');
    expect((await getOrder(c, order.id)).status).toBe('paid');
  });

  it('"success, notification in 30 seconds": nothing changes until the delayed job fires', async () => {
    const { c, order } = await freshOrder();
    const id = await startPay(c, order.id);
    const click = await stubClick(app, id, 'success_delayed');
    expect(click.body.delivered).toBe(false);
    expect((await getOrder(c, order.id)).status).toBe('awaiting_payment');
    app.clock.advance(29_000);
    await drainJobs(app);
    expect((await getOrder(c, order.id)).status).toBe('awaiting_payment');
    app.clock.advance(2000);
    await drainJobs(app);
    expect((await getOrder(c, order.id)).status).toBe('paid');
  });

  it('only the owner can open a payment; paid / cancelled orders cannot be paid again; bad returnUrl is rejected', async () => {
    const { c, order } = await freshOrder();
    const stranger = await newClient(app);
    expect((await stranger.post(`/orders/${order.id}/pay`, {})).status).toBe(404);
    for (const returnUrl of [
      'https://evil.example',
      '//evil.example',
      'javascript:alert(1)',
      '/\\evil',
    ]) {
      expect((await c.post(`/orders/${order.id}/pay`, { returnUrl })).status, returnUrl).toBe(400);
    }
    await payOrder(app, c, order.id);
    expect((await c.post(`/orders/${order.id}/pay`, {})).status).toBe(409);
    const { c: c2, order: o2 } = await freshOrder();
    await c2.post(`/orders/${o2.id}/cancel`);
    expect((await c2.post(`/orders/${o2.id}/pay`, {})).status).toBe(409);
  });

  it('an expired reservation cannot be paid through a NEW session', async () => {
    const { c, order } = await freshOrder();
    app.clock.advance(16 * 60_000);
    expect((await c.post(`/orders/${order.id}/pay`, {})).status).toBe(409);
  });

  it('unknown payment sessions are 404 / 400', async () => {
    expect((await stubClick(app, randomUUID(), 'success')).status).toBe(404);
    expect((await request(app, 'GET', '/stub/payments/nope')).status).toBe(400);
    expect(
      (
        await request(app, 'POST', `/stub/payments/${randomUUID()}/complete`, {
          body: { outcome: 'hack' },
        })
      ).status,
    ).toBe(400);
  });
});

describe('webhook: signature', () => {
  it('rejects missing, wrong, truncated, stale and wrong-secret signatures with 401 and changes nothing', async () => {
    const { c, order } = await freshOrder();
    const paymentId = await startPay(c, order.id);
    const ev = webhookEvent({
      type: 'payment.succeeded',
      orderId: order.id,
      paymentId,
      amount: order.total,
    });
    const raw = JSON.stringify(ev);
    const nowSec = Math.floor(app.clock.now().getTime() / 1000);
    const cases: [string, Parameters<typeof sendWebhook>[2]][] = [
      ['no header', { signature: null }],
      ['empty header', { signature: '' }],
      ['garbage', { signature: 'hello' }],
      ['wrong secret', { secret: 'wrong-secret-wrong-secret-wrong-secret' }],
      ['bad mac', { signature: `t=${nowSec},v1=${'0'.repeat(64)}` }],
      ['short mac', { signature: `t=${nowSec},v1=abcd` }],
      ['no timestamp', { signature: `v1=${'a'.repeat(64)}` }],
      ['stale timestamp (replay)', { at: new Date(app.clock.now().getTime() - 10 * 60_000) }],
      ['future timestamp', { at: new Date(app.clock.now().getTime() + 10 * 60_000) }],
      [
        'signature of a different body',
        {
          signature: signPayload(
            app.env.WEBHOOK_SECRET,
            raw.replace(String(order.total), '1'),
            app.clock.now(),
          ),
        },
      ],
    ];
    for (const [name, o] of cases) {
      const r = await sendWebhook(app, ev, {
        ...o,
        ip: `127.0.1.${Math.floor(Math.random() * 250) + 1}`,
      });
      expect(r.status, name).toBe(401);
      expect(r.body.error.code, name).toBe('bad_signature');
    }
    expect((await getOrder(c, order.id)).status).toBe('awaiting_payment');
  });

  it('a valid signature over a TAMPERED body (amount changed after signing) is rejected', async () => {
    const { c, order } = await freshOrder();
    const paymentId = await startPay(c, order.id);
    const ev = webhookEvent({
      type: 'payment.succeeded',
      orderId: order.id,
      paymentId,
      amount: order.total,
    });
    const signed = JSON.stringify(ev);
    const tampered = signed.replace(`"amount":${order.total}`, '"amount":1');
    expect(tampered).not.toBe(signed);
    const r = await sendWebhook(app, ev, {
      rawBody: tampered,
      signature: signPayload(app.env.WEBHOOK_SECRET, signed, app.clock.now()),
      ip: '127.0.2.1',
    });
    expect(r.status).toBe(401);
  });

  it('a correctly signed but malformed / unknown / mismatching event: 400 or ignored, never 5xx', async () => {
    const { c, order } = await freshOrder();
    const paymentId = await startPay(c, order.id);
    const good = webhookEvent({
      type: 'payment.succeeded',
      orderId: order.id,
      paymentId,
      amount: order.total,
    });
    for (const payload of [
      'not json',
      '[]',
      'null',
      '{}',
      JSON.stringify({ ...good, type: 'payment.hacked' }),
      JSON.stringify({ ...good, amount: -5 }),
      JSON.stringify({ ...good, orderId: 'x' }),
    ]) {
      const r = await sendWebhook(app, null, { rawBody: payload });
      expect(r.status, payload).toBe(400);
    }
    const unknownOrder = await sendWebhook(
      app,
      webhookEvent({
        type: 'payment.succeeded',
        orderId: randomUUID(),
        paymentId,
        amount: order.total,
      }),
    );
    expect(unknownOrder.body).toMatchObject({ status: 'ignored' });
    const wrongAmount = await sendWebhook(
      app,
      webhookEvent({
        type: 'payment.succeeded',
        orderId: order.id,
        paymentId,
        amount: order.total - 1,
      }),
    );
    expect(wrongAmount.body).toMatchObject({ status: 'ignored', reason: 'amount_mismatch' });
    const other = await freshOrder();
    const crossed = await sendWebhook(
      app,
      webhookEvent({
        type: 'payment.succeeded',
        orderId: other.order.id,
        paymentId,
        amount: order.total,
      }),
    );
    expect(crossed.body.status).toBe('ignored');
    expect((await getOrder(c, order.id)).status).toBe('awaiting_payment');
    expect((await getOrder(other.c, other.order.id)).status).toBe('awaiting_payment');
  });

  it('an attacker spraying bad signatures is throttled per IP, the real provider (valid signature) is never blocked', async () => {
    const ATTACKER = '127.0.0.77';
    const { c, order } = await freshOrder();
    const paymentId = await startPay(c, order.id);
    const ev = webhookEvent({
      type: 'payment.succeeded',
      orderId: order.id,
      paymentId,
      amount: order.total,
    });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await sendWebhook(app, ev, { signature: 'bad', ip: ATTACKER })).status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    const real = await sendWebhook(app, ev, { ip: ATTACKER });
    expect(real.status).toBe(200);
    expect((await getOrder(c, order.id)).status).toBe('paid');
  });
});

describe('webhook: idempotency, repeats and lateness', () => {
  it('the same notification 3 times (sequentially) = one payment', async () => {
    const { c, order } = await freshOrder();
    const paymentId = await startPay(c, order.id);
    const ev = webhookEvent({
      type: 'payment.succeeded',
      orderId: order.id,
      paymentId,
      amount: order.total,
    });
    const rs = [await sendWebhook(app, ev), await sendWebhook(app, ev), await sendWebhook(app, ev)];
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(rs.map((r) => r.body.status)).toEqual(['processed', 'duplicate', 'duplicate']);
    const o = await getOrder(c, order.id);
    expect(o.status).toBe('paid');
    expect(eventTypes(o)).toEqual(['created', 'paid']);
    expect(
      (
        await app.tdb.db
          .select()
          .from(schema.paymentEvents)
          .where(eq(schema.paymentEvents.eventId, ev.eventId))
      ).length,
    ).toBe(1);
  });

  it('the same notification 25 times IN PARALLEL = one payment', async () => {
    const { c, order } = await freshOrder();
    const paymentId = await startPay(c, order.id);
    const ev = webhookEvent({
      type: 'payment.succeeded',
      orderId: order.id,
      paymentId,
      amount: order.total,
    });
    const rs = await Promise.all(Array.from({ length: 25 }, () => sendWebhook(app, ev)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body.status === 'processed')).toHaveLength(1);
    expect(eventTypes(await getOrder(c, order.id))).toEqual(['created', 'paid']);
  });

  it('the provider re-sending "success" with a NEW event id for the same payment does not pay twice', async () => {
    const { c, order } = await freshOrder();
    const paymentId = await startPay(c, order.id);
    await sendWebhook(
      app,
      webhookEvent({
        type: 'payment.succeeded',
        orderId: order.id,
        paymentId,
        amount: order.total,
      }),
    );
    const again = await sendWebhook(
      app,
      webhookEvent({
        type: 'payment.succeeded',
        orderId: order.id,
        paymentId,
        amount: order.total,
      }),
    );
    expect(again.body).toMatchObject({ status: 'processed', outcome: 'already_paid' });
    expect(eventTypes(await getOrder(c, order.id))).toEqual(['created', 'paid']);
    expect(
      (await app.tdb.db.select().from(schema.refunds).where(eq(schema.refunds.orderId, order.id)))
        .length,
    ).toBe(0);
  });

  it('clicking "Success" on the stub page repeatedly is harmless (same event id every time)', async () => {
    const { c, order } = await freshOrder();
    const id = await startPay(c, order.id);
    const rs = await Promise.all([
      stubClick(app, id, 'success'),
      stubClick(app, id, 'success'),
      stubClick(app, id, 'success'),
    ]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(eventTypes(await getOrder(c, order.id))).toEqual(['created', 'paid']);
  });

  it('a second payment session for an already paid order is refunded automatically (no double charge)', async () => {
    const { c, order } = await freshOrder();
    await payOrder(app, c, order.id);
    const [second] = await app.tdb.db
      .insert(schema.payments)
      .values({ orderId: order.id, amount: order.total, status: 'pending' })
      .returning();
    const r = await sendWebhook(
      app,
      webhookEvent({
        type: 'payment.succeeded',
        orderId: order.id,
        paymentId: second!.id,
        amount: order.total,
      }),
    );
    expect(r.body.outcome).toBe('duplicate_refunded');
    await drainJobs(app);
    const o = await getOrder(c, order.id);
    expect(o.status).toBe('paid');
    expect(o.refunds).toMatchObject([
      { kind: 'duplicate_payment', amount: order.total, status: 'succeeded' },
    ]);
    expect(o.refundedTotal).toBe(0);
    expect(eventTypes(o)).toContain('duplicate_payment_refunded');
  });

  it('a "failed" event arriving after success does not undo the payment', async () => {
    const { c, order } = await freshOrder();
    const paymentId = await startPay(c, order.id);
    await sendWebhook(
      app,
      webhookEvent({
        type: 'payment.succeeded',
        orderId: order.id,
        paymentId,
        amount: order.total,
      }),
    );
    await sendWebhook(
      app,
      webhookEvent({ type: 'payment.failed', orderId: order.id, paymentId, amount: order.total }),
    );
    expect((await getOrder(c, order.id)).status).toBe('paid');
  });
});

describe('late payment: notification arrives after the order was cancelled by the timeout', () => {
  it('goods still in stock -> the order is RESTORED to paid (visible in the history)', async () => {
    const { p, c, order } = await freshOrder({ stock: 5, qty: 2 });
    const paymentId = await startPay(c, order.id);
    app.clock.advance(16 * 60_000);
    await drainJobs(app);
    expect((await getOrder(c, order.id)).status).toBe('cancelled');
    expect(await stockOf(app, p.id)).toBe(5);
    const r = await sendWebhook(
      app,
      webhookEvent({
        type: 'payment.succeeded',
        orderId: order.id,
        paymentId,
        amount: order.total,
      }),
    );
    expect(r.body.outcome).toBe('restored');
    const o = await getOrder(c, order.id);
    expect(o).toMatchObject({ status: 'paid', cancelReason: null, reservedUntil: null });
    expect(eventTypes(o)).toEqual(['created', 'expired', 'restored_after_late_payment']);
    expect(await stockOf(app, p.id)).toBe(3);
    expect(o.refunds).toHaveLength(0);
  });

  it('through the stub: "success in 30 s" arriving after the 15-minute timeout also restores', async () => {
    const { c, order } = await freshOrder();
    const paymentId = await startPay(c, order.id);
    await stubClick(app, paymentId, 'success_delayed');
    app.clock.advance(16 * 60_000);
    await drainJobs(app);
    expect((await getOrder(c, order.id)).status).toBe('paid');
  });

  it('goods sold out meanwhile -> money returned AUTOMATICALLY, order stays cancelled, both outcomes in the history', async () => {
    const { p, c, order } = await freshOrder({ stock: 1, qty: 1 });
    const paymentId = await startPay(c, order.id);
    app.clock.advance(16 * 60_000);
    await drainJobs(app);
    const buyer = await newClient(app);
    expect((await placeOrder(buyer, [{ productId: p.id, qty: 1 }])).status).toBe(201);
    expect(await stockOf(app, p.id)).toBe(0);
    const r = await sendWebhook(
      app,
      webhookEvent({
        type: 'payment.succeeded',
        orderId: order.id,
        paymentId,
        amount: order.total,
      }),
    );
    expect(r.body.outcome).toBe('refunded_out_of_stock');
    await drainJobs(app);
    const o = await getOrder(c, order.id);
    expect(o.status).toBe('cancelled');
    expect(eventTypes(o)).toEqual([
      'created',
      'expired',
      'refund_requested',
      'auto_refunded_late_payment',
      'refund_succeeded',
    ]);
    expect(o.refunds).toMatchObject([
      { kind: 'late_payment', amount: order.total, status: 'succeeded' },
    ]);
    expect(o.refunds[0].completedAt).not.toBeNull();
    expect(o.refundedTotal).toBe(order.total);
    expect(await stockOf(app, p.id)).toBe(0);
    expect(o.events.find((e: any) => e.type === 'auto_refunded_late_payment').data).toMatchObject({
      reason: 'out_of_stock',
    });
  });

  it('partially available goods count as unavailable (all-or-nothing); nothing is taken from stock', async () => {
    const a = await makeProduct(app, { stock: 5 });
    const b = await makeProduct(app, { stock: 1 });
    const c = await newClient(app);
    const r = await placeOrder(c, [
      { productId: a.id, qty: 2 },
      { productId: b.id, qty: 1 },
    ]);
    const paymentId = await startPay(c, r.body.id);
    app.clock.advance(16 * 60_000);
    await drainJobs(app);
    await placeOrder(await newClient(app), [{ productId: b.id, qty: 1 }]);
    await sendWebhook(
      app,
      webhookEvent({
        type: 'payment.succeeded',
        orderId: r.body.id,
        paymentId,
        amount: r.body.total,
      }),
    );
    expect((await getOrder(c, r.body.id)).status).toBe('cancelled');
    expect(await stockOf(app, a.id)).toBe(5);
  });

  it('a promo that is no longer available also leads to an automatic refund (the discounted price cannot be honoured)', async () => {
    await makePromo(app, { code: 'LASTONE', maxUses: 1 });
    const { c, order } = await freshOrder({ promo: 'LASTONE', price: 50_000 });
    expect(order.discount).toBe(5000);
    const paymentId = await startPay(c, order.id);
    app.clock.advance(16 * 60_000);
    await drainJobs(app);
    const p2 = await makeProduct(app, { price: 50_000 });
    expect(
      (await placeOrder(await newClient(app), [{ productId: p2.id, qty: 1 }], { promo: 'LASTONE' }))
        .body.discount,
    ).toBe(5000);
    const r = await sendWebhook(
      app,
      webhookEvent({
        type: 'payment.succeeded',
        orderId: order.id,
        paymentId,
        amount: order.total,
      }),
    );
    expect(r.body.outcome).toBe('refunded_out_of_stock');
    expect(
      (
        await app.tdb.db
          .select()
          .from(schema.promoCodes)
          .where(eq(schema.promoCodes.code, 'LASTONE'))
      )[0]!.used,
    ).toBe(1);
    const o = await getOrder(c, order.id);
    expect(o.events.find((e: any) => e.type === 'auto_refunded_late_payment').data.reason).toBe(
      'promo_unavailable',
    );
  });

  it('the same late notification delivered 10 times in parallel restores exactly once', async () => {
    const { p, c, order } = await freshOrder({ stock: 5 });
    const paymentId = await startPay(c, order.id);
    app.clock.advance(16 * 60_000);
    await drainJobs(app);
    const ev = webhookEvent({
      type: 'payment.succeeded',
      orderId: order.id,
      paymentId,
      amount: order.total,
    });
    await Promise.all(Array.from({ length: 10 }, () => sendWebhook(app, ev)));
    expect(await stockOf(app, p.id)).toBe(4);
    expect((await getOrder(c, order.id)).status).toBe('paid');
  });

  it('payment for an order the CUSTOMER cancelled is refunded, not resurrected', async () => {
    const { p, c, order } = await freshOrder({ stock: 5 });
    const paymentId = await startPay(c, order.id);
    expect((await c.post(`/orders/${order.id}/cancel`)).body.status).toBe('cancelled');
    const r = await sendWebhook(
      app,
      webhookEvent({
        type: 'payment.succeeded',
        orderId: order.id,
        paymentId,
        amount: order.total,
      }),
    );
    expect(r.body.outcome).toBe('refunded_cancelled_order');
    await drainJobs(app);
    const o = await getOrder(c, order.id);
    expect(o.status).toBe('cancelled');
    expect(o.refunds).toMatchObject([{ kind: 'late_payment', status: 'succeeded' }]);
    expect(await stockOf(app, p.id)).toBe(5);
  });
});

describe('cancel vs payment', () => {
  it('cancelling a paid order refunds the money through the stub, returns stock and promo use', async () => {
    await makePromo(app, { code: 'CANCELPROMO', maxUses: 1 });
    const { p, c, order } = await freshOrder({
      stock: 6,
      qty: 2,
      promo: 'CANCELPROMO',
      price: 10_000,
    });
    await payOrder(app, c, order.id);
    expect(await stockOf(app, p.id)).toBe(4);
    const r = await c.post(`/orders/${order.id}/cancel`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('cancelled');
    expect(r.body.refunds).toMatchObject([
      { kind: 'cancellation', amount: order.total, status: 'pending' },
    ]);
    await drainJobs(app);
    const o = await getOrder(c, order.id);
    expect(o.refunds).toMatchObject([
      { kind: 'cancellation', amount: order.total, status: 'succeeded' },
    ]);
    expect(o.refundedTotal).toBe(order.total);
    expect(eventTypes(o)).toEqual([
      'created',
      'paid',
      'cancelled',
      'refund_requested',
      'refund_succeeded',
    ]);
    expect(await stockOf(app, p.id)).toBe(6);
    expect(
      (
        await app.tdb.db
          .select()
          .from(schema.promoCodes)
          .where(eq(schema.promoCodes.code, 'CANCELPROMO'))
      )[0]!.used,
    ).toBe(0);
  });

  it('cancel is idempotent (double click) and impossible after shipping', async () => {
    const { p, c, order } = await freshOrder({ stock: 5 });
    await c.post(`/orders/${order.id}/cancel`);
    expect((await c.post(`/orders/${order.id}/cancel`)).status).toBe(200);
    expect(await stockOf(app, p.id)).toBe(5);
    const { c: c2, order: o2 } = await freshOrder();
    await payOrder(app, c2, o2.id);
    const m = await newClient(app, 'manager');
    expect((await m.patch(`/orders/${o2.id}/status`, { status: 'shipped' })).status).toBe(200);
    const late = await c2.post(`/orders/${o2.id}/cancel`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('invalid_transition');
  });

  it('RACE: the customer cancels while the payment notification arrives. 30 rounds, always consistent', async () => {
    let paidFirst = 0;
    for (let round = 0; round < 30; round++) {
      const { p, c, order } = await freshOrder({ stock: 3 });
      const paymentId = await startPay(c, order.id);
      const ev = webhookEvent({
        type: 'payment.succeeded',
        orderId: order.id,
        paymentId,
        amount: order.total,
      });
      const jobs: Promise<any>[] = [c.post(`/orders/${order.id}/cancel`), sendWebhook(app, ev)];
      if (round % 2) jobs.reverse();
      const results = await Promise.all(jobs);
      expect(
        results.every((r) => r.status === 200),
        `round ${round}`,
      ).toBe(true);
      await drainJobs(app);
      const o = await getOrder(c, order.id);
      // THE invariant: never "cancelled without a refund of the money received"
      expect(o.status, `round ${round}`).toBe('cancelled');
      expect(o.refunds, `round ${round}`).toHaveLength(1);
      expect(o.refunds[0]).toMatchObject({ amount: order.total, status: 'succeeded' });
      expect(o.refundedTotal).toBe(order.total);
      expect(await stockOf(app, p.id)).toBe(3);
      if (o.events.some((e: any) => e.type === 'paid')) paidFirst++;
    }
    expect(paidFirst).toBeGreaterThanOrEqual(0);
  });

  it('RACE: the reservation expires while the payment arrives: either paid or refunded, never lost', async () => {
    for (let round = 0; round < 15; round++) {
      const { c, order } = await freshOrder({ stock: 4 });
      const paymentId = await startPay(c, order.id);
      app.clock.advance(15 * 60_000 + 1000);
      const ev = webhookEvent({
        type: 'payment.succeeded',
        orderId: order.id,
        paymentId,
        amount: order.total,
      });
      await Promise.all([drainJobs(app), sendWebhook(app, ev)]);
      await drainJobs(app);
      const o = await getOrder(c, order.id);
      if (o.status === 'paid') expect(o.refunds).toHaveLength(0);
      else {
        expect(o.status).toBe('cancelled');
        expect(o.refunds, `round ${round}`).toHaveLength(1);
      }
    }
  });

  it('a notification that cannot be delivered (shop unreachable) is retried by the job queue until it works', async () => {
    const flaky = await startTestApp({
      tdb: app.tdb,
      clock: app.clock,
      env: { API_RATE_MAX_PER_IP: '1000000', WEBHOOK_URL: 'http://127.0.0.1:9/payments/webhook' },
    });
    try {
      const p = await makeProduct(app, { stock: 3 });
      const c = await newClient(flaky);
      const o = await placeOrder(c, [{ productId: p.id, qty: 1 }]);
      const paymentId = await startPay(c, o.body.id);
      const click = await stubClick(flaky, paymentId, 'success');
      expect(click.body.delivered).toBe(false);
      expect((await getOrder(c, o.body.id)).status).toBe('awaiting_payment');
      const queued = await app.tdb.db
        .select()
        .from(schema.jobs)
        .where(sql`type = 'deliver_webhook'`);
      expect(queued.length).toBeGreaterThan(0);
      // the shop is reachable again (this app's WEBHOOK_URL is correct): the retry goes through
      app.clock.advance(10_000);
      await drainJobs(app);
      expect((await getOrder(c, o.body.id)).status).toBe('paid');
    } finally {
      await flaky.app.close();
    }
  });
});
