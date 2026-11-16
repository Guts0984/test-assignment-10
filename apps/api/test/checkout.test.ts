/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely typed JSON responses */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@shop/db';
import { startTestApp, type TestApp } from './harness';
import {
  COURIER_ADDRESS,
  drainJobs,
  getOrder,
  makeProduct,
  makePromo,
  newClient,
  placeOrder,
  runJobs,
  stockOf,
  type Client,
} from './shop';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({ env: { API_RATE_MAX_PER_IP: '1000000', MAX_PENDING_ORDERS: '5' } });
});
afterAll(async () => app.close());

describe('placing an order', () => {
  it('creates an awaiting_payment order, reserves stock for 15 minutes, snapshots prices, empties the cart', async () => {
    const a = await makeProduct(app, { name: 'Alpha', price: 3333, stock: 10 });
    const b = await makeProduct(app, { name: 'Beta', price: 1999, stock: 10 });
    const c = await newClient(app);
    const r = await placeOrder(c, [
      { productId: a.id, qty: 1 },
      { productId: b.id, qty: 3 },
    ]);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: 'awaiting_payment',
      subtotal: 3333 + 5997,
      discount: 0,
      delivery: 0,
      total: 9330,
      deliveryMethod: 'pickup',
      pendingPayment: false,
    });
    expect(r.body.number).toMatch(/^ORD-\d+$/);
    expect(new Date(r.body.reservedUntil).getTime() - app.clock.now().getTime()).toBe(15 * 60_000);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.events.map((e: any) => e.type)).toEqual(['created']);
    expect(await stockOf(app, a.id)).toBe(9);
    expect(await stockOf(app, b.id)).toBe(7);
    expect((await c.get('/cart')).body.lines).toHaveLength(0);
  });

  it('later price changes do not touch the order: it keeps the price at the moment of ordering', async () => {
    const p = await makeProduct(app, { price: 5000 });
    const c = await newClient(app);
    const r = await placeOrder(c, [{ productId: p.id, qty: 2 }]);
    await app.tdb.db
      .update(schema.products)
      .set({ price: 9999, name: 'Renamed' })
      .where(eq(schema.products.id, p.id));
    const o = await getOrder(c, r.body.id);
    expect(o.items[0]).toMatchObject({ unitPrice: 5000, qty: 2, net: 10_000 });
    expect(o.items[0].name).not.toBe('Renamed');
    expect(o.total).toBe(10_000);
  });

  it('delivery: pickup is free; courier costs 100 ₴ below 2000 ₴ after discount and is free from 2000 ₴', async () => {
    const cheap = await makeProduct(app, { price: 150_000, stock: 50 }); // 1500 ₴
    const dear = await makeProduct(app, { price: 200_000, stock: 50 }); // 2000 ₴
    const c = await newClient(app);
    const low = await placeOrder(c, [{ productId: cheap.id, qty: 1 }], { delivery: 'courier' });
    expect(low.body).toMatchObject({
      delivery: 10_000,
      total: 160_000,
      address: expect.objectContaining({ city: 'Kyiv' }),
    });
    const high = await placeOrder(c, [{ productId: dear.id, qty: 1 }], { delivery: 'courier' });
    expect(high.body).toMatchObject({ delivery: 0, total: 200_000 });
    const pick = await placeOrder(c, [{ productId: cheap.id, qty: 1 }], { delivery: 'pickup' });
    expect(pick.body).toMatchObject({ delivery: 0, total: 150_000, address: null });
  });

  it('the free-delivery threshold is checked AFTER the promo discount', async () => {
    const p = await makeProduct(app, { price: 210_000, stock: 50 }); // 2100 ₴, 10% -> 1890 ₴
    await makePromo(app, { code: 'TEN', type: 'percent', value: 10, oncePerCustomer: false });
    const c = await newClient(app);
    const r = await placeOrder(c, [{ productId: p.id, qty: 1 }], {
      promo: 'TEN',
      delivery: 'courier',
    });
    expect(r.body).toMatchObject({
      subtotal: 210_000,
      discount: 21_000,
      delivery: 10_000,
      total: 199_000,
    });
  });

  it('refuses an empty cart, a bad address and a missing / malformed Idempotency-Key', async () => {
    const c = await newClient(app);
    expect(
      (await c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() })).body.error
        .code,
    ).toBe('cart_empty');
    const p = await makeProduct(app);
    await c.put(`/cart/items/${p.id}`, { qty: 1 });
    expect((await c.post('/orders', { deliveryMethod: 'pickup' })).status).toBe(400);
    expect(
      (await c.post('/orders', { deliveryMethod: 'pickup' }, { key: 'not-a-uuid' })).status,
    ).toBe(400);
    expect(
      (await c.post('/orders', { deliveryMethod: 'courier' }, { key: randomUUID() })).status,
    ).toBe(400);
    for (const bad of [
      { postalCode: '123' },
      { phone: 'abc' },
      { fullName: 'x' },
      { city: '' },
      { building: '' },
    ]) {
      const r = await c.post(
        '/orders',
        { deliveryMethod: 'courier', address: { ...COURIER_ADDRESS, ...bad } },
        { key: randomUUID() },
      );
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.stringify(r.body.error.details)).toContain('address');
    }
    expect(
      (
        await c.post(
          '/orders',
          { deliveryMethod: 'pickup', expectedTotal: -1 },
          { key: randomUUID() },
        )
      ).status,
    ).toBe(400);
    // nothing was created or reserved by the failed attempts
    expect((await c.get('/orders')).body.items).toHaveLength(0);
  });

  it('only customers can order', async () => {
    const m = await newClient(app, 'manager');
    expect(
      (await m.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() })).status,
    ).toBe(403);
  });
});

describe('not enough stock', () => {
  it('no order is created and the customer sees which products and how many are left', async () => {
    const a = await makeProduct(app, { name: 'Plenty', stock: 10 });
    const b = await makeProduct(app, { name: 'Scarce', stock: 2 });
    const d = await makeProduct(app, { name: 'Gone', stock: 0 });
    const c = await newClient(app);
    const r = await placeOrder(c, [
      { productId: a.id, qty: 3 },
      { productId: b.id, qty: 5 },
      { productId: d.id, qty: 1 },
    ]);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('insufficient_stock');
    expect(
      r.body.error.details.shortages.sort((x: any, y: any) => x.name.localeCompare(y.name)),
    ).toEqual([
      { productId: d.id, name: 'Gone', requested: 1, available: 0 },
      { productId: b.id, name: 'Scarce', requested: 5, available: 2 },
    ]);
    expect(await stockOf(app, a.id)).toBe(10); // nothing taken from the available product either
    expect((await c.get('/orders')).body.items).toHaveLength(0);
    expect((await c.get('/cart')).body.lines).toHaveLength(3); // cart kept so the customer can fix it
  });

  it('a product hidden after it went into the cart counts as unavailable', async () => {
    const p = await makeProduct(app, { stock: 5 });
    const c = await newClient(app);
    await c.put(`/cart/items/${p.id}`, { qty: 1 });
    await app.tdb.db
      .update(schema.products)
      .set({ active: false })
      .where(eq(schema.products.id, p.id));
    const r = await c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('insufficient_stock');
  });
});

describe('price changes between cart and checkout', () => {
  it('the order is refused until the customer confirms the new price; then it goes through at that price', async () => {
    const p = await makeProduct(app, { price: 10_000, stock: 9 });
    const c = await newClient(app);
    await c.put(`/cart/items/${p.id}`, { qty: 2 });
    await app.tdb.db
      .update(schema.products)
      .set({ price: 11_000 })
      .where(eq(schema.products.id, p.id));
    const refused = await c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'price_changed',
      details: { changes: [{ productId: p.id, oldPrice: 10_000, newPrice: 11_000 }] },
    });
    expect(await stockOf(app, p.id)).toBe(9); // nothing was reserved
    await c.post('/cart/accept-prices');
    const ok = await c.post(
      '/orders',
      { deliveryMethod: 'pickup', expectedTotal: 22_000 },
      { key: randomUUID() },
    );
    expect(ok.status).toBe(201);
    expect(ok.body.total).toBe(22_000);
  });

  it('expectedTotal protects against a total the customer did not see', async () => {
    const p = await makeProduct(app, { price: 10_000 });
    const c = await newClient(app);
    const r = await placeOrder(c, [{ productId: p.id, qty: 1 }], { expectedTotal: 9_999 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: 'total_mismatch',
      details: { expected: 9_999, actual: 10_000 },
    });
  });

  it('a price change racing with checkout never lets the old price through', async () => {
    for (let i = 0; i < 5; i++) {
      const p = await makeProduct(app, { price: 10_000, stock: 10 });
      const c = await newClient(app);
      await c.put(`/cart/items/${p.id}`, { qty: 1 });
      const [order] = await Promise.all([
        c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() }),
        app.tdb.db
          .update(schema.products)
          .set({ price: 12_000 })
          .where(eq(schema.products.id, p.id)),
      ]);
      // either the order was priced at the old price BEFORE the change (and the customer had seen it), or refused
      if (order.status === 201) expect(order.body.total).toBe(10_000);
      else expect(order.body.error.code).toBe('price_changed');
    }
  });
});

describe('idempotent checkout (double click, dropped connection)', () => {
  it('the same Idempotency-Key returns the SAME order, even sequentially and after the cart is gone', async () => {
    const p = await makeProduct(app, { stock: 5 });
    const c = await newClient(app);
    const key = randomUUID();
    const first = await placeOrder(c, [{ productId: p.id, qty: 2 }], { key });
    const retry = await c.post('/orders', { deliveryMethod: 'pickup' }, { key });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(await stockOf(app, p.id)).toBe(3); // reserved once
    expect((await c.get('/orders')).body.items).toHaveLength(1);
  });

  it('20 simultaneous identical requests (double click storm) create exactly one order', async () => {
    const p = await makeProduct(app, { stock: 5 });
    const c = await newClient(app);
    await c.put(`/cart/items/${p.id}`, { qty: 1 });
    const key = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => c.post('/orders', { deliveryMethod: 'pickup' }, { key })),
    );
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await stockOf(app, p.id)).toBe(4);
    const count = await app.tdb.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.orders)
      .where(eq(schema.orders.userId, c.userId));
    expect(count[0]!.n).toBe(1);
  });

  it('parallel requests with DIFFERENT keys cannot both consume one cart', async () => {
    const p = await makeProduct(app, { stock: 5 });
    const c = await newClient(app);
    await c.put(`/cart/items/${p.id}`, { qty: 1 });
    const rs = await Promise.all(
      Array.from({ length: 6 }, () =>
        c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() }),
      ),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      rs.filter((r) => r.status === 409).every((r) => r.body.error.code === 'cart_empty'),
    ).toBe(true);
    expect(await stockOf(app, p.id)).toBe(4);
  });

  it('keys are per customer: another customer cannot read or collide with my order through my key', async () => {
    const p = await makeProduct(app, { stock: 5 });
    const [a, b] = [await newClient(app), await newClient(app)];
    const key = randomUUID();
    const oa = await placeOrder(a, [{ productId: p.id, qty: 1 }], { key });
    const ob = await placeOrder(b, [{ productId: p.id, qty: 1 }], { key });
    expect(ob.status).toBe(201);
    expect(ob.body.id).not.toBe(oa.body.id);
  });
});

describe('the last item', () => {
  it('two customers order the last unit at the same time: one order, one refusal, stock never negative', async () => {
    for (let round = 0; round < 10; round++) {
      const p = await makeProduct(app, { stock: 1 });
      const [a, b] = [await newClient(app), await newClient(app)];
      await a.put(`/cart/items/${p.id}`, { qty: 1 });
      await b.put(`/cart/items/${p.id}`, { qty: 1 });
      const [ra, rb] = await Promise.all([
        a.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() }),
        b.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() }),
      ]);
      expect([ra.status, rb.status].sort(), `round ${round}`).toEqual([201, 409]);
      const loser = ra.status === 409 ? ra : rb;
      expect(loser.body.error).toMatchObject({
        code: 'insufficient_stock',
        details: { shortages: [{ productId: p.id, requested: 1, available: 0 }] },
      });
      expect(await stockOf(app, p.id)).toBe(0);
    }
  });

  it('30 customers fight for 7 units: exactly 7 win, no oversell', async () => {
    const p = await makeProduct(app, { stock: 7 });
    const customers = await Promise.all(Array.from({ length: 30 }, () => newClient(app)));
    for (const c of customers) await c.put(`/cart/items/${p.id}`, { qty: 1 });
    const rs = await Promise.all(
      customers.map((c) => c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() })),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(7);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(23);
    expect(rs.every((r) => r.status < 500)).toBe(true);
    expect(await stockOf(app, p.id)).toBe(0);
  });

  it('mixed multi-item carts in opposite order do not deadlock and never oversell', async () => {
    const a = await makeProduct(app, { stock: 10 });
    const b = await makeProduct(app, { stock: 10 });
    const customers = await Promise.all(Array.from({ length: 24 }, () => newClient(app)));
    await Promise.all(
      customers.map(async (c, i) => {
        const items = i % 2 ? [a, b] : [b, a];
        for (const p of items) await c.put(`/cart/items/${p.id}`, { qty: 1 });
      }),
    );
    const rs = await Promise.all(
      customers.map((c) => c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() })),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(10);
    expect(rs.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(await stockOf(app, a.id)).toBe(0);
    expect(await stockOf(app, b.id)).toBe(0);
  });
});

describe('order numbers', () => {
  it('50 simultaneous checkouts get 50 consecutive numbers with no gaps and no duplicates', async () => {
    const p = await makeProduct(app, { stock: 1000, price: 100 });
    const customers = await Promise.all(Array.from({ length: 50 }, () => newClient(app)));
    for (const c of customers) await c.put(`/cart/items/${p.id}`, { qty: 1 });
    const before = (await app.tdb.db.select().from(schema.orderCounter))[0]!.last;
    const rs = await Promise.all(
      customers.map((c) => c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() })),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const numbers = rs
      .map((r) => Number((r.body.number as string).replace('ORD-', '')))
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => before + 1 + i));
  });

  it('failed checkouts (out of stock, bad promo) do not burn order numbers', async () => {
    const scarce = await makeProduct(app, { stock: 0 });
    const ok = await makeProduct(app, { stock: 10 });
    const c = await newClient(app);
    const before = (await app.tdb.db.select().from(schema.orderCounter))[0]!.last;
    for (let i = 0; i < 5; i++)
      await placeOrder(await newClient(app), [{ productId: scarce.id, qty: 1 }]);
    const good = await placeOrder(c, [{ productId: ok.id, qty: 1 }]);
    expect(good.body.number).toBe(`ORD-${before + 1}`);
  });

  it('the first order of a fresh database is ORD-10234', async () => {
    const fresh = await startTestApp({ env: { API_RATE_MAX_PER_IP: '1000000' } });
    try {
      const p = await makeProduct(fresh);
      const c = await newClient(fresh);
      expect((await placeOrder(c, [{ productId: p.id, qty: 1 }])).body.number).toBe('ORD-10234');
    } finally {
      await fresh.close();
    }
  });
});

describe('promo codes at checkout', () => {
  it('limit 1, two customers at the same moment: exactly one gets the discount', async () => {
    for (let round = 0; round < 8; round++) {
      const p = await makeProduct(app, { price: 100_000, stock: 10 });
      await makePromo(app, { code: `LIM1R${round}`, maxUses: 1, type: 'percent', value: 10 });
      const [a, b] = [await newClient(app), await newClient(app)];
      for (const c of [a, b]) {
        await c.put(`/cart/items/${p.id}`, { qty: 1 });
        expect(
          (await c.post('/cart/promo', { code: `limr${round}`.replace('limr', 'LIM1R') })).status,
        ).toBe(200); // both can APPLY it...
      }
      const [ra, rb] = await Promise.all([
        a.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() }),
        b.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() }),
      ]);
      // ...but only one may REDEEM it
      expect([ra.status, rb.status].sort(), `round ${round}`).toEqual([201, 409]);
      const winner = ra.status === 201 ? ra : rb;
      const loser = ra.status === 201 ? rb : ra;
      expect(winner.body).toMatchObject({
        discount: 10_000,
        total: 90_000,
        promoCode: `LIM1R${round}`,
      });
      expect(loser.body.error).toMatchObject({
        code: 'promo_rejected',
        details: { reason: 'limit_reached' },
      });
      const promo = (
        await app.tdb.db
          .select()
          .from(schema.promoCodes)
          .where(eq(schema.promoCodes.code, `LIM1R${round}`))
      )[0]!;
      expect(promo.used).toBe(1);
      // the loser's stock was given back by the rollback
      expect(await stockOf(app, p.id)).toBe(9);
    }
  });

  it('40 customers race for a limit-5 code: exactly 5 discounts', async () => {
    const p = await makeProduct(app, { price: 50_000, stock: 100 });
    await makePromo(app, { code: 'LIMIT5', maxUses: 5 });
    const cs = await Promise.all(Array.from({ length: 40 }, () => newClient(app)));
    for (const c of cs) {
      await c.put(`/cart/items/${p.id}`, { qty: 1 });
      await c.post('/cart/promo', { code: 'LIMIT5' });
    }
    const rs = await Promise.all(
      cs.map((c) => c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() })),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(5);
    expect(
      rs.filter((r) => r.status === 409).every((r) => r.body.error.code === 'promo_rejected'),
    ).toBe(true);
    expect(
      (
        await app.tdb.db
          .select()
          .from(schema.promoCodes)
          .where(eq(schema.promoCodes.code, 'LIMIT5'))
      )[0]!.used,
    ).toBe(5);
  });

  it('once per customer: the same customer cannot use a code twice, even with parallel orders', async () => {
    const p = await makeProduct(app, { price: 20_000, stock: 50 });
    await makePromo(app, { code: 'ONEPERSON', oncePerCustomer: true });
    const c = await newClient(app);
    const first = await placeOrder(c, [{ productId: p.id, qty: 1 }], { promo: 'ONEPERSON' });
    expect(first.status).toBe(201);
    await c.put(`/cart/items/${p.id}`, { qty: 1 });
    const again = await c.post('/cart/promo', { code: 'ONEPERSON' });
    expect(again.body.error.details.reason).toBe('already_used');
  });

  it('a customer racing two carts with the same once-per-customer code gets one discount', async () => {
    const p = await makeProduct(app, { price: 20_000, stock: 50 });
    await makePromo(app, { code: 'RACE1', oncePerCustomer: true });
    const c = await newClient(app);
    await c.put(`/cart/items/${p.id}`, { qty: 1 });
    await c.post('/cart/promo', { code: 'RACE1' });
    // two checkouts of the SAME cart with different keys: the per-customer lock serialises them
    const rs = await Promise.all([
      c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() }),
      c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() }),
    ]);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      (
        await app.tdb.db
          .select()
          .from(schema.promoRedemptions)
          .where(eq(schema.promoRedemptions.userId, c.userId))
      ).length,
    ).toBe(1);
  });

  it('discount is distributed over the items and sums to the order discount to the kopeck', async () => {
    const [a, b, d] = await Promise.all([
      makeProduct(app, { price: 3333, stock: 9 }),
      makeProduct(app, { price: 1999, stock: 9 }),
      makeProduct(app, { price: 12_345, stock: 9 }),
    ]);
    await makePromo(app, { code: 'SEVEN', type: 'percent', value: 7, oncePerCustomer: false });
    const c = await newClient(app);
    const r = await placeOrder(
      c,
      [
        { productId: a.id, qty: 1 },
        { productId: b.id, qty: 3 },
        { productId: d.id, qty: 2 },
      ],
      { promo: 'seven' },
    );
    expect(r.body).toMatchObject({ subtotal: 34_020, discount: 2381, total: 31_639 });
    const shares = Object.fromEntries(r.body.items.map((i: any) => [i.unitPrice, i.discountShare]));
    expect(shares).toEqual({ 3333: 233, 1999: 420, 12345: 1728 }); // 233 + 420 + 1728 = 2381 (largest remainder)
    expect(r.body.items.reduce((s: number, i: any) => s + i.net, 0)).toBe(31_639);
  });
});

describe('reservation: unpaid orders expire after 15 minutes', () => {
  it('after 15 minutes the job cancels the order, returns the stock and the promo use', async () => {
    const p = await makeProduct(app, { stock: 4, price: 10_000 });
    await makePromo(app, { code: 'EXPPROMO', maxUses: 1 });
    const c = await newClient(app);
    const r = await placeOrder(c, [{ productId: p.id, qty: 3 }], { promo: 'EXPPROMO' });
    expect(await stockOf(app, p.id)).toBe(1);
    await runJobs(app); // nothing is due yet
    expect((await getOrder(c, r.body.id)).status).toBe('awaiting_payment');
    app.clock.advance(14 * 60_000 + 59_000);
    await runJobs(app);
    expect((await getOrder(c, r.body.id)).status).toBe('awaiting_payment'); // 14:59 - still reserved
    app.clock.advance(2000);
    await runJobs(app);
    const o = await getOrder(c, r.body.id);
    expect(o).toMatchObject({ status: 'cancelled', cancelReason: 'expired', reservedUntil: null });
    expect(o.events.map((e: any) => e.type)).toEqual(['created', 'expired']);
    expect(await stockOf(app, p.id)).toBe(4);
    expect(
      (
        await app.tdb.db
          .select()
          .from(schema.promoCodes)
          .where(eq(schema.promoCodes.code, 'EXPPROMO'))
      )[0]!.used,
    ).toBe(0);
    // the code can be used again by someone else
    const other = await newClient(app);
    expect(
      (await placeOrder(other, [{ productId: p.id, qty: 1 }], { promo: 'EXPPROMO' })).body.discount,
    ).toBe(1000);
  });

  it('running the expiry job twice (or on a paid order) changes nothing', async () => {
    const p = await makeProduct(app, { stock: 4 });
    const c = await newClient(app);
    const r = await placeOrder(c, [{ productId: p.id, qty: 1 }]);
    app.clock.advance(16 * 60_000);
    await runJobs(app);
    await app.tdb.db
      .insert(schema.jobs)
      .values({ type: 'expire_order', payload: { orderId: r.body.id }, runAt: app.clock.now() });
    await runJobs(app);
    expect(await stockOf(app, p.id)).toBe(4); // restored exactly once
  });

  it('a customer cannot hoard stock with unpaid orders: at most 5 awaiting_payment orders', async () => {
    const p = await makeProduct(app, { stock: 100 });
    const c = await newClient(app);
    for (let i = 0; i < 5; i++)
      expect((await placeOrder(c, [{ productId: p.id, qty: 1 }])).status).toBe(201);
    const sixth = await placeOrder(c, [{ productId: p.id, qty: 1 }]);
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe('conflict');
    expect(await stockOf(app, p.id)).toBe(95);
  });

  it('many orders expiring at once: every unit comes back exactly once', async () => {
    const p = await makeProduct(app, { stock: 40 });
    const cs: Client[] = await Promise.all(Array.from({ length: 20 }, () => newClient(app)));
    for (const c of cs) await placeOrder(c, [{ productId: p.id, qty: 2 }]);
    expect(await stockOf(app, p.id)).toBe(0);
    app.clock.advance(16 * 60_000);
    await Promise.all([runJobs(app), runJobs(app), runJobs(app)]);
    await drainJobs(app);
    expect(await stockOf(app, p.id)).toBe(40);
  });
});
