/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely typed JSON responses */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@shop/db';
import { startTestApp, type TestApp } from './harness';
import {
  drainJobs,
  getOrder,
  makeProduct,
  newClient,
  placeOrder,
  sendWebhook,
  startPay,
  stubClick,
  webhookEvent,
  type Client,
} from './shop';

let app: TestApp;
let c: Client;
beforeAll(async () => {
  app = await startTestApp({
    env: {
      API_RATE_MAX_PER_IP: '1000000',
      LOGIN_MAX_PER_IP: '100000',
      LOGIN_MAX_PER_IP_ACCOUNT: '100000',
    },
  });
  c = await newClient(app, 'customer');
});
afterAll(async () => app.close());

const newOrder = async (price = 5_000) => {
  const p = await makeProduct(app, { stock: 50, price });
  return (await placeOrder(c, [{ productId: p.id, qty: 1 }])).body;
};
const succeeded = (orderId: string, paymentId: string, amount: number) =>
  sendWebhook(app, webhookEvent({ type: 'payment.succeeded', orderId, paymentId, amount }));
const sum = (rs: { amount: number }[]) => rs.reduce((s, r) => s + r.amount, 0);

describe('a SECOND payment for an order that was already cancelled and refunded', () => {
  it('first attempt failed, second paid, order cancelled (refunded) - then the FIRST attempt reports success: money goes back, no 500', async () => {
    const o = await newOrder();
    const first = await startPay(c, o.id);
    await stubClick(app, first, 'failure'); // attempt 1 is declined...
    const second = await startPay(c, o.id); // ...the customer tries again: a NEW payment
    expect(second).not.toBe(first);
    expect((await stubClick(app, second, 'success')).status).toBe(200);
    expect((await getOrder(c, o.id)).status).toBe('paid');
    expect((await c.post(`/orders/${o.id}/cancel`, {})).status).toBe(200); // refunds the 50.00 once
    await drainJobs(app);

    // the provider now says attempt 1 succeeded after all (a late / contradicting notification)
    const r = await succeeded(o.id, first, o.total);
    expect(r.status, JSON.stringify(r.json)).toBe(200); // used to be 500 (CHECK refunded_total <= total)

    await drainJobs(app);
    const after = await getOrder(c, o.id);
    expect(after.status).toBe('cancelled');
    // BOTH payments were refunded in full: 2 x 50.00 went back, nothing is left with the shop
    expect(sum(after.refunds)).toBe(2 * o.total);
    expect(after.refunds.every((x: any) => x.status === 'succeeded')).toBe(true);
    expect(after.refunds.map((x: any) => x.kind).sort()).toEqual([
      'cancellation',
      'duplicate_payment',
    ]);
    // the order's own books are not pushed past the total
    expect(after.refundedTotal).toBe(o.total);
    expect(after.events.some((e: any) => e.type === 'duplicate_payment_refunded')).toBe(true);
  });

  it('the same notification delivered again changes nothing (no third refund)', async () => {
    const o = await newOrder();
    const first = await startPay(c, o.id);
    await stubClick(app, first, 'failure');
    const second = await startPay(c, o.id);
    await stubClick(app, second, 'success');
    await c.post(`/orders/${o.id}/cancel`, {});
    const ev = webhookEvent({
      type: 'payment.succeeded',
      orderId: o.id,
      paymentId: first,
      amount: o.total,
    });
    for (let i = 0; i < 3; i++) expect((await sendWebhook(app, ev)).status).toBe(200);
    await drainJobs(app);
    expect(sum((await getOrder(c, o.id)).refunds)).toBe(2 * o.total);
  });

  it('cancelled before paying, then two different payments succeed: the first is a late payment, the second a duplicate - both refunded', async () => {
    const o = await newOrder();
    const first = await startPay(c, o.id);
    // a second session exists at the provider as well (declined first, opened again)
    await stubClick(app, first, 'failure');
    const second = await startPay(c, o.id);
    expect((await c.post(`/orders/${o.id}/cancel`, {})).status).toBe(200);
    expect((await succeeded(o.id, first, o.total)).status).toBe(200);
    const r2 = await succeeded(o.id, second, o.total);
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    await drainJobs(app);
    const after = await getOrder(c, o.id);
    expect(after.status).toBe('cancelled');
    expect(sum(after.refunds)).toBe(2 * o.total);
    expect(after.refunds.every((x: any) => x.status === 'succeeded')).toBe(true);
    expect(after.refundedTotal).toBeLessThanOrEqual(o.total);
  });

  it('both notifications at the very same instant: one refund each, never a 500, exactly one of them a duplicate', async () => {
    const o = await newOrder();
    const first = await startPay(c, o.id);
    await stubClick(app, first, 'failure');
    const second = await startPay(c, o.id);
    await c.post(`/orders/${o.id}/cancel`, {});
    const rs = await Promise.all([
      succeeded(o.id, first, o.total),
      succeeded(o.id, second, o.total),
    ]);
    for (const r of rs) expect(r.status, JSON.stringify(r.json)).toBe(200);
    await drainJobs(app);
    const after = await getOrder(c, o.id);
    expect(sum(after.refunds)).toBe(2 * o.total);
    expect(after.refunds.map((x: any) => x.kind).sort()).toEqual([
      'duplicate_payment',
      'late_payment',
    ]);
    expect(after.refundedTotal).toBe(o.total);
  });

  it('an EXPIRED order that was already refunded does not come back to life on a second payment', async () => {
    const o = await newOrder();
    const first = await startPay(c, o.id);
    await stubClick(app, first, 'failure');
    const second = await startPay(c, o.id);
    app.clock.advance((app.env.RESERVATION_MINUTES + 1) * 60_000);
    await drainJobs(app); // the reservation expires, the order is cancelled
    expect((await getOrder(c, o.id)).status).toBe('cancelled');
    // payment arrives late: stock is free, so the order is restored and paid
    expect((await succeeded(o.id, second, o.total)).status).toBe(200);
    expect((await getOrder(c, o.id)).status).toBe('paid');
    // and the OTHER attempt then reports success too: that is a second payment for a paid order
    const r = await succeeded(o.id, first, o.total);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await drainJobs(app);
    const after = await getOrder(c, o.id);
    expect(after.status).toBe('paid');
    expect(after.refunds.map((x: any) => x.kind)).toEqual(['duplicate_payment']);
    expect(after.refundedTotal).toBe(0);
  });

  it('safety net: whatever the path, a refund can never push refunded_total above the total (it is booked as an extra-money refund instead)', async () => {
    const o = await newOrder();
    const first = await startPay(c, o.id);
    await stubClick(app, first, 'success');
    await c.post(`/orders/${o.id}/cancel`, {});
    // a payment row the normal API cannot create any more (the order is cancelled): add it directly
    const [extra] = await app.tdb.db
      .insert(schema.payments)
      .values({ orderId: o.id, amount: o.total, status: 'pending' })
      .returning();
    const r = await succeeded(o.id, extra!.id, o.total);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await drainJobs(app);
    const after = await getOrder(c, o.id);
    expect(sum(after.refunds)).toBe(2 * o.total);
    expect(after.refundedTotal).toBe(o.total);
  });
});
