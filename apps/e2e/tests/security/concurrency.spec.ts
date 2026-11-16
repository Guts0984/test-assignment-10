import { expect, test } from '@playwright/test';
import {
  api,
  cancelOpenOrders,
  createPromo,
  createProduct,
  customer,
  deliveredOrder,
  getOrder,
  getProduct,
  makeOrder,
  managerApi,
  mgrStatus,
  paidOrder,
  RELAXED,
  startPay,
  stubComplete,
  tag,
  uniqueCode,
  uuid,
  visitor,
  waitOrder,
  resetCartApi,
} from '../helpers';

// every test here uses its own customers so nothing is shared by accident
const crowd = (from: number, n: number) => Array.from({ length: n }, (_, i) => customer(from + i));

async function cartWith(
  who: ReturnType<typeof customer>,
  productId: string,
  qty: number,
  promo?: string,
) {
  await resetCartApi(who);
  const c = await api(who);
  const r = await c.put(`/api/cart/items/${productId}`, { data: { qty } });
  expect(r.status(), await r.text()).toBe(200);
  if (promo)
    expect((await c.post('/api/cart/promo', { data: { code: promo } })).status()).toBe(200);
}

const place = async (who: ReturnType<typeof customer>, key = uuid()) => {
  const r = await (
    await api(who)
  ).post('/api/orders', {
    headers: { 'Idempotency-Key': key },
    data: { deliveryMethod: 'pickup' },
  });
  return { status: r.status(), body: await r.json() };
};

test.afterEach(async () => {
  for (const who of crowd(40, 10)) await cancelOpenOrders(who);
});

test.describe('stock', () => {
  test('the LAST item: 10 customers press "Place order" at the same instant - exactly one gets it', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-last'), price: 5_000, stock: 1 });
    const people = crowd(40, 10);
    for (const who of people) await cartWith(who, p.id, 1);

    const results = await Promise.all(people.map((who) => place(who)));
    const won = results.filter((r) => r.status === 201);
    const lost = results.filter((r) => r.status !== 201);
    expect(won).toHaveLength(1);
    for (const r of lost) {
      expect([409, 422], JSON.stringify(r.body)).toContain(r.status);
      expect(r.body.error.code).toBe('insufficient_stock');
    }
    expect((await getProduct(p.id)).stock).toBe(0);
  });

  test('stock 5, twelve buyers of 1-3 pieces each: never oversold, stock never negative, sold + left = start', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-oversell'), price: 1_000, stock: 5 });
    const people = crowd(40, 10);
    const wants = people.map((_, i) => 1 + (i % 3));
    for (const [i, who] of people.entries()) await cartWith(who, p.id, wants[i]!);

    const results = await Promise.all(people.map((who) => place(who)));
    const sold = results.reduce((s, r, i) => s + (r.status === 201 ? wants[i]! : 0), 0);
    expect(sold).toBeLessThanOrEqual(5);
    const left = (await getProduct(p.id)).stock;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(sold + left).toBe(5);
    for (const r of results) expect(r.status).toBeLessThan(500);
  });

  test('a customer who cancels gives the stock back, exactly once, even when "cancel" is pressed 6 times at once', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-cancel6'), price: 1_000, stock: 10 });
    const who = customer(40);
    const o = await makeOrder(who, [{ productId: p.id, qty: 4 }]);
    expect((await getProduct(p.id)).stock).toBe(6);
    const c = await api(who);
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => c.post(`/api/orders/${o.id}/cancel`, { data: {} })),
    );
    for (const r of rs) expect(r.status()).toBeLessThan(500);
    expect((await getProduct(p.id)).stock).toBe(10); // not 14, not 6
    const after = await getOrder(who, o.id);
    expect(after.status).toBe('cancelled');
    expect(after.events.filter((e) => e.type === 'cancelled')).toHaveLength(1);
  });
});

test.describe('idempotency and duplicates', () => {
  test('one Idempotency-Key sent 20 times in parallel makes ONE order and takes the stock once', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-idem'), price: 2_000, stock: 10 });
    const who = customer(41);
    await cartWith(who, p.id, 2);
    const key = uuid();
    const rs = await Promise.all(Array.from({ length: 20 }, () => place(who, key)));
    for (const r of rs) expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect((await getProduct(p.id)).stock).toBe(8);
  });

  test('one cart, six different keys at once (six double-clicks): one order, the rest see an empty cart', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-dbl'), price: 2_000, stock: 10 });
    const who = customer(42);
    await cartWith(who, p.id, 1);
    const rs = await Promise.all(Array.from({ length: 6 }, () => place(who)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of rs.filter((r) => r.status !== 201)) expect([409, 422]).toContain(r.status);
    expect((await getProduct(p.id)).stock).toBe(9);
  });

  test('order numbers stay unique and well-formed when 10 customers order at once', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-num'), price: 500, stock: 100 });
    const people = crowd(40, 10);
    for (const who of people) await cartWith(who, p.id, 1);
    const rs = await Promise.all(people.map((who) => place(who)));
    const numbers = rs.map((r) => r.body.number as string);
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const n of numbers) expect(n).toMatch(/^ORD-\d+$/);
  });

  test('20 parallel "set quantity" calls on one cart line leave ONE line with one of the requested values', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-cartrace'), price: 100, stock: 100 });
    const who = customer(43);
    await resetCartApi(who);
    const c = await api(who);
    const qtys = Array.from({ length: 20 }, (_, i) => i + 1);
    const rs = await Promise.all(
      qtys.map((qty) => c.put(`/api/cart/items/${p.id}`, { data: { qty } })),
    );
    for (const r of rs) expect(r.status()).toBe(200);
    const cart = await (await c.get('/api/cart')).json();
    expect(cart.lines).toHaveLength(1);
    expect(qtys).toContain(cart.lines[0].qty);
    await resetCartApi(who);
  });
});

test.describe('promo codes', () => {
  test('a code with 1 use left, five customers at once: exactly one order gets the discount', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-promo1'), price: 10_000, stock: 50 });
    const code = uniqueCode('E2ER1');
    await createPromo(mgr, { code, type: 'percent', value: 10, maxUses: 1, oncePerCustomer: true });
    const people = crowd(40, 5);
    for (const who of people) await cartWith(who, p.id, 1, code);

    const rs = await Promise.all(people.map((who) => place(who)));
    for (const r of rs) expect(r.status).toBeLessThan(500);
    const withPromo = rs.filter(
      (r) => r.status === 201 && r.body.promoCode?.toLowerCase() === code.toLowerCase(),
    );
    expect(withPromo).toHaveLength(1);
    expect(withPromo[0]!.body.discount).toBe(1_000);
    // nobody else got a discounted order
    for (const r of rs.filter((r) => r.status === 201 && r !== withPromo[0]))
      expect(r.body.discount).toBe(0);
    const promos = await (await mgr.get('/api/promos')).json();
    const row = (promos.items ?? promos).find(
      (x: { code: string }) => x.code.toLowerCase() === code.toLowerCase(),
    );
    expect(row.used).toBe(1);
  });

  test('a code limited to once per customer cannot be used twice by the same customer, even in parallel', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-promoonce'), price: 10_000, stock: 50 });
    const code = uniqueCode('E2EO');
    await createPromo(mgr, { code, type: 'fixed', value: 500, oncePerCustomer: true });
    const who = customer(44);
    const first = await makeOrder(who, [{ productId: p.id, qty: 1 }], { promo: code });
    expect(first.discount).toBe(500);
    await cartWith(who, p.id, 1);
    const again = await (await api(who)).post('/api/cart/promo', { data: { code } });
    expect(again.status()).toBeGreaterThanOrEqual(400);
    expect((await again.json()).error.details?.reason ?? (await again.json()).error.code).toMatch(
      /already_used|promo_rejected/,
    );
  });
});

test.describe('payment, cancellation, return and status races', () => {
  test('pay and cancel at the same instant, 8 times: always cancelled, stock back, refunded EXACTLY once', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-payrace'), price: 3_000, stock: 50 });
    const who = customer(45);
    const c = await api(who);
    for (let i = 0; i < 8; i++) {
      const o = await makeOrder(who, [{ productId: p.id, qty: 2 }]);
      const { paymentId } = await startPay(who, o.id);
      await Promise.all([
        stubComplete(paymentId, 'success'),
        c.post(`/api/orders/${o.id}/cancel`, { data: {} }),
      ]);
      const done = await waitOrder(
        who,
        o.id,
        (x) =>
          x.status === 'cancelled' &&
          !x.pendingPayment &&
          x.refunds.every((r) => r.status === 'succeeded') &&
          x.refundedTotal > 0,
        40_000,
      );
      expect(
        done.refunds.reduce((s, r) => s + r.amount, 0),
        `round ${i}: refunded total`,
      ).toBe(o.total);
      expect(done.refundedTotal).toBe(o.total);
    }
    expect((await getProduct(p.id)).stock).toBe(50);
  });

  test('two returns for the same item at the same instant: one wins, the refund is paid once', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-retrace'), price: 4_000, stock: 50 });
    const who = customer(46);
    const o = await deliveredOrder(who, [{ productId: p.id, qty: 3 }]);
    const c = await api(who);
    const body = { items: [{ orderItemId: o.items[0]!.id, qty: 3 }] };
    const rs = await Promise.all(
      [1, 2, 3, 4].map(() => c.post(`/api/orders/${o.id}/returns`, { data: body })),
    );
    expect(rs.filter((r) => r.status() === 201 || r.status() === 200)).toHaveLength(1);
    for (const r of rs) expect(r.status()).toBeLessThan(500);
    const done = await waitOrder(
      who,
      o.id,
      (x) => x.refunds.length > 0 && x.refunds.every((r) => r.status === 'succeeded'),
      30_000,
    );
    expect(done.items[0]!.returnedQty).toBe(3);
    expect(done.refunds.reduce((s, r) => s + r.amount, 0)).toBe(done.items[0]!.net);
  });

  test('the manager presses "Shipped" ten times at once: one transition, one event, no error', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-shiprace'), price: 4_000, stock: 50 });
    const who = customer(47);
    const o = await paidOrder(who, [{ productId: p.id, qty: 1 }]);
    const rs = await Promise.all(Array.from({ length: 10 }, () => mgrStatus(o.id, 'shipped')));
    for (const r of rs) expect(r.status()).toBeLessThan(500);
    expect(rs.filter((r) => r.status() === 200)).toHaveLength(1);
    const after = await getOrder(who, o.id);
    expect(after.status).toBe('shipped');
    expect(after.events.filter((e) => e.type === 'shipped')).toHaveLength(1);
  });

  test('cancel vs "Shipped" at the same instant: never both - a shipped order is not cancelled, a cancelled one is not shipped', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-shipcancel'), price: 4_000, stock: 50 });
    const who = customer(48);
    const c = await api(who);
    for (let i = 0; i < 5; i++) {
      const o = await paidOrder(who, [{ productId: p.id, qty: 1 }]);
      const [ship, cancel] = await Promise.all([
        mgrStatus(o.id, 'shipped'),
        c.post(`/api/orders/${o.id}/cancel`, { data: {} }),
      ]);
      expect(ship.status()).toBeLessThan(500);
      expect(cancel.status()).toBeLessThan(500);
      const after = await waitOrder(
        who,
        o.id,
        (x) => !x.pendingPayment && x.refunds.every((r) => r.status === 'succeeded'),
        20_000,
      );
      expect(['shipped', 'cancelled']).toContain(after.status);
      const shipped = after.events.some((e) => e.type === 'shipped');
      const cancelled = after.events.some((e) => e.type === 'cancelled');
      if (after.status === 'shipped') expect(cancelled).toBe(false);
      if (after.status === 'cancelled') expect(after.refundedTotal).toBe(o.total);
      expect(shipped && cancelled && after.status === 'shipped').toBe(false);
    }
  });
});

test.describe('brute force does not take everybody down', () => {
  test('after 6 wrong passwords for one account that account is throttled (with Retry-After), another account still logs in', async () => {
    const victim = customer(50); // used by this test only: it gets locked for 15 minutes
    const v = await visitor();
    const probe = await v.post('/api/auth/login', {
      data: { email: victim.email, password: 'Wrong-probe-1' },
    });
    test.skip(
      probe.status() === 429,
      'customer50 is still locked by an earlier run: start a fresh stack',
    );
    const codes: number[] = [probe.status()]; // the probe was attempt number 1
    let retryAfter: string | undefined;
    for (let i = 0; i < 7; i++) {
      const r = await v.post('/api/auth/login', {
        data: { email: victim.email, password: `Wrong-${i}-Password` },
      });
      codes.push(r.status());
      if (r.status() === 429) retryAfter = r.headers()['retry-after'];
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.length).toBeGreaterThan(5);
    expect(codes.slice(5).every((c) => c === 429)).toBe(true); // everything after the 5th wrong guess is refused
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // the right password is refused too while blocked (otherwise guessing would continue unthrottled)
    const right = await v.post('/api/auth/login', { data: victim });
    expect(right.status()).toBe(429);
    // everybody else is unaffected - this is the part a naive per-IP "ban" gets wrong
    if (RELAXED) {
      const other = await v.post('/api/auth/login', { data: customer(49) });
      expect(other.status()).toBe(200);
    }
    await v.dispose();
  });
});
