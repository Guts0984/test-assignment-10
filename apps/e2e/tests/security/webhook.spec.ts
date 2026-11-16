import { expect, test } from '@playwright/test';
import {
  api,
  cancelOpenOrders,
  createProduct,
  customer,
  getOrder,
  makeOrder,
  managerApi,
  startPay,
  stubComplete,
  sendWebhook,
  tag,
  uuid,
  WEBHOOK_SECRET,
  type Order,
} from '../helpers';

test.skip(!WEBHOOK_SECRET, 'E2E_WEBHOOK_SECRET is not set (run through `pnpm test:stack`)');

const W = customer(37);

/** An order that is waiting for a payment, plus its payment session. */
async function pending(who = W, price = 4_200, qty = 1) {
  const mgr = await managerApi();
  const p = await createProduct(mgr, { name: tag('E2E-hook'), price, stock: 20 });
  const order = await makeOrder(who, [{ productId: p.id, qty }]);
  const { paymentId } = await startPay(who, order.id);
  return { order, paymentId, product: p };
}

const event = (type: string, o: Order, paymentId: string, extra: Record<string, unknown> = {}) => ({
  eventId: uuid(),
  type,
  paymentId,
  orderId: o.id,
  amount: o.total,
  occurredAt: new Date().toISOString(),
  ...extra,
});

test.describe.configure({ mode: 'serial' });

// the shop allows 5 unpaid orders per customer: tidy up so tests do not run into that limit
test.beforeAll(async () => {
  test.setTimeout(150_000);
  await cancelOpenOrders(W);
  // bad signatures are throttled per minute and per address: a rerun right after a flood would get
  // 429 instead of 401 everywhere. Wait the window out so the checks below test what they claim.
  const bad = () =>
    sendWebhook({}, { signature: `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` });
  for (let i = 0; i < 70 && (await bad()).status === 429; i++)
    await new Promise((r) => setTimeout(r, 1000));
});
test.afterEach(async () => cancelOpenOrders(W));

test.describe('signature checks (the notification is the ONLY thing that can mark an order paid)', () => {
  test('missing, empty, malformed and wrongly signed notifications are 401 and change nothing', async () => {
    const { order, paymentId } = await pending();
    const ev = event('payment.succeeded', order, paymentId);
    const good = await sendWebhook(ev);
    expect(good.status).toBe(200); // control: the same event, correctly signed, is accepted...
    const { order: o2, paymentId: p2 } = await pending(); // ...so use a fresh order for the attacks
    const forged = event('payment.succeeded', o2, p2);

    const attempts: Record<string, Parameters<typeof sendWebhook>[1]> = {
      'no header': { signature: '' },
      'garbage header': { signature: 'hello' },
      'only t': { signature: `t=${Math.floor(Date.now() / 1000)}` },
      'only v1': { signature: `v1=${'a'.repeat(64)}` },
      'short mac': { signature: `t=${Math.floor(Date.now() / 1000)},v1=abcd` },
      'non-hex mac': { signature: `t=${Math.floor(Date.now() / 1000)},v1=${'z'.repeat(64)}` },
      'wrong secret': { secret: 'not-the-secret-not-the-secret-not-the-secret' },
      'empty secret': { secret: '' },
      'secret of the stub name': { secret: 'webhook' },
    };
    for (const [name, o] of Object.entries(attempts)) {
      const r = await sendWebhook(forged, o);
      expect(r.status, name).toBe(401);
    }
    expect((await getOrder(W, o2.id)).status).toBe('awaiting_payment');
  });

  test('the signature covers the BODY: changing one byte (amount, order, type) after signing is refused', async () => {
    const { order, paymentId } = await pending();
    const ev = event('payment.succeeded', order, paymentId);
    const signed = JSON.stringify(ev);
    for (const tampered of [
      signed.replace(String(order.total), '1'),
      signed.replace('payment.succeeded', 'payment.failed'),
      signed.replace(order.id, uuid()),
      signed + ' ',
      ' ' + signed,
    ]) {
      const r = await sendWebhook(ev, { body: tampered });
      expect(r.status).toBe(401);
    }
    expect((await getOrder(W, order.id)).status).toBe('awaiting_payment');
  });

  test('replay protection: an old (or far-future) timestamp is refused even with a valid MAC', async () => {
    const { order, paymentId } = await pending();
    const ev = event('payment.succeeded', order, paymentId);
    for (const secs of [-3600, -400, 3600]) {
      const r = await sendWebhook(ev, { at: new Date(Date.now() + secs * 1000) });
      expect(r.status, `${secs}s`).toBe(401);
    }
    expect((await getOrder(W, order.id)).status).toBe('awaiting_payment');
    // inside the tolerance (5 minutes) it is accepted
    const ok = await sendWebhook(ev, { at: new Date(Date.now() - 240_000) });
    expect(ok.status).toBe(200);
    expect((await getOrder(W, order.id)).status).toBe('paid');
  });
});

test.describe('what a valid notification may and may not do', () => {
  test('a replayed event is acknowledged every time but applied ONCE', async () => {
    const { order, paymentId } = await pending();
    const ev = event('payment.succeeded', order, paymentId);
    for (let i = 0; i < 4; i++) expect((await sendWebhook(ev)).status).toBe(200);
    const o = await getOrder(W, order.id);
    expect(o.status).toBe('paid');
    expect(o.events.filter((e) => e.type === 'paid')).toHaveLength(1);
    expect(o.refunds).toHaveLength(0);
  });

  test('25 identical notifications at the same instant: one payment, no duplicate refund', async () => {
    const { order, paymentId } = await pending();
    const ev = event('payment.succeeded', order, paymentId);
    const rs = await Promise.all(Array.from({ length: 25 }, () => sendWebhook(ev)));
    for (const r of rs) expect(r.status).toBeLessThan(500);
    const o = await getOrder(W, order.id);
    expect(o.status).toBe('paid');
    expect(o.events.filter((e) => e.type === 'paid')).toHaveLength(1);
    expect(o.refunds).toHaveLength(0);
  });

  test('the amount is checked: a signed "succeeded" for a different amount does not pay the order', async () => {
    const { order, paymentId } = await pending(W, 9_900);
    const r = await sendWebhook(event('payment.succeeded', order, paymentId, { amount: 1 }));
    expect(r.status).toBeLessThan(500);
    const o = await getOrder(W, order.id);
    expect(o.status, 'paying 1 kopeck must not buy a 99.00 order').not.toBe('paid');
  });

  test('a paymentId that belongs to ANOTHER order cannot pay this one', async () => {
    const a = await pending();
    const b = await pending();
    const r = await sendWebhook(event('payment.succeeded', a.order, b.paymentId));
    expect(r.status).toBeLessThan(500);
    expect((await getOrder(W, a.order.id)).status).toBe('awaiting_payment');
    expect((await getOrder(W, b.order.id)).status).toBe('awaiting_payment');
  });

  test('unknown order / payment / refund ids are handled without a 5xx and without side effects', async () => {
    const { order } = await pending();
    const ghost = { ...order, id: uuid() } as Order;
    for (const ev of [
      event('payment.succeeded', ghost, uuid()),
      event('payment.failed', ghost, uuid()),
      event('refund.succeeded', ghost, uuid(), { refundId: uuid() }),
    ]) {
      const r = await sendWebhook(ev);
      expect(r.status, JSON.stringify(ev.type)).toBeLessThan(500);
    }
    expect((await getOrder(W, order.id)).status).toBe('awaiting_payment');
  });

  test('wrong shapes (valid signature, invalid content) are a 400, not a crash', async () => {
    const bad: unknown[] = [
      {},
      [],
      'text',
      { type: 'payment.succeeded' },
      {
        eventId: 'x',
        type: 'payment.succeeded',
        paymentId: 'y',
        orderId: 'z',
        amount: 1,
        occurredAt: 'now',
      },
      {
        eventId: uuid(),
        type: 'nope',
        paymentId: uuid(),
        orderId: uuid(),
        amount: 1,
        occurredAt: new Date().toISOString(),
      },
      {
        eventId: uuid(),
        type: 'payment.succeeded',
        paymentId: uuid(),
        orderId: uuid(),
        amount: -5,
        occurredAt: new Date().toISOString(),
      },
      {
        eventId: uuid(),
        type: 'payment.succeeded',
        paymentId: uuid(),
        orderId: uuid(),
        amount: 1.5,
        occurredAt: new Date().toISOString(),
      },
      {
        eventId: uuid(),
        type: 'payment.succeeded',
        paymentId: uuid(),
        orderId: uuid(),
        amount: 2 ** 60,
        occurredAt: new Date().toISOString(),
      },
    ];
    for (const b of bad) {
      const r = await sendWebhook(b as Record<string, unknown>);
      expect(r.status, JSON.stringify(b).slice(0, 60)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    // not JSON at all, but correctly signed
    const raw = await sendWebhook({}, { body: 'not json' });
    expect([400, 401]).toContain(raw.status); // broken JSON or a MAC over other bytes: refused either way
  });

  test('a failure notice after a success does not undo the payment', async () => {
    const { order, paymentId } = await pending();
    expect((await sendWebhook(event('payment.succeeded', order, paymentId))).status).toBe(200);
    await sendWebhook(event('payment.failed', order, paymentId));
    expect((await getOrder(W, order.id)).status).toBe('paid');
  });

  test('money for an order the customer already cancelled is sent back, once, and the order stays cancelled', async () => {
    const { order, paymentId } = await pending();
    expect(
      (await (await api(W)).post(`/api/orders/${order.id}/cancel`, { data: {} })).status(),
    ).toBe(200);
    const ev = event('payment.succeeded', order, paymentId);
    await Promise.all([sendWebhook(ev), sendWebhook(ev), sendWebhook(ev)]);
    await expect
      .poll(async () => (await getOrder(W, order.id)).refundedTotal, { timeout: 30_000 })
      .toBe(order.total);
    const o = await getOrder(W, order.id);
    expect(o.status).toBe('cancelled');
    expect(o.refunds.reduce((s, r) => s + r.amount, 0)).toBe(order.total); // never more than was paid
  });

  test('the stub page cannot be completed twice: the second click does not charge again', async () => {
    const { order, paymentId } = await pending();
    expect((await stubComplete(paymentId, 'success')).status).toBeLessThan(300);
    const second = await stubComplete(paymentId, 'success');
    expect(second.status).toBeLessThan(500);
    const o = await getOrder(W, order.id);
    expect(o.events.filter((e) => e.type === 'paid')).toHaveLength(1);
    expect(o.refunds.reduce((s, r) => s + r.amount, 0)).toBe(0);
  });
});

test.describe('abuse of the webhook endpoint itself', () => {
  test('a body over the limit is 413 and a flood of bad signatures is throttled (and never a 5xx)', async () => {
    const big = await sendWebhook({}, { body: JSON.stringify({ x: 'y'.repeat(150_000) }) });
    expect(big.status).toBe(413);

    const codes: number[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await sendWebhook(
        event('payment.succeeded', { id: uuid(), total: 1 } as Order, uuid()),
        {
          signature: `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
        },
      );
      codes.push(r.status);
    }
    expect(codes.every((c) => c < 500)).toBe(true);
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes).toContain(429); // after ~30 bad signatures in a minute the address is throttled
  });
});
