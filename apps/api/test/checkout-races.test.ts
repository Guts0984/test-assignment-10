/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely typed JSON responses */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './harness';
import { COURIER_ADDRESS, makeProduct, newClient, placeOrder, type Client } from './shop';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({
    env: {
      API_RATE_MAX_PER_IP: '1000000',
      LOGIN_MAX_PER_IP: '100000',
      LOGIN_MAX_PER_IP_ACCOUNT: '100000',
      MAX_PENDING_ORDERS: '1000',
    },
  });
});
afterAll(async () => app.close());

describe('a line added from another device WHILE the checkout runs', () => {
  it('is never lost: after 40 races every accepted line is either in the order or still in the cart', async () => {
    const c = await newClient(app, 'customer');
    const a = await makeProduct(app, { stock: 100_000 });
    const b = await makeProduct(app, { stock: 100_000 });
    let lost = 0;
    let both = 0;
    for (let i = 0; i < 40; i++) {
      await c.put(`/cart/items/${a.id}`, { qty: 1 });
      const [order, add] = await Promise.all([
        c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() }),
        c.put(`/cart/items/${b.id}`, { qty: 1 }),
      ]);
      expect(order.status, JSON.stringify(order.body)).toBe(201);
      expect(add.status).toBe(200); // the customer was told "added"
      const inOrder = order.body.items.some((x: any) => x.productId === b.id);
      const inCart = (await c.get('/cart')).body.lines.some((x: any) => x.productId === b.id);
      if (!inOrder && !inCart) lost++;
      if (inOrder && inCart) both++; // not allowed either: bought AND still waiting in the cart
      await c.del(`/cart/items/${b.id}`);
    }
    expect(lost, 'lines that were accepted but ended up nowhere').toBe(0);
    expect(both).toBe(0);
  });

  it('the order contains exactly what it was priced for, and only that leaves the cart', async () => {
    const c = await newClient(app, 'customer');
    const a = await makeProduct(app, { stock: 50, price: 1000 });
    const b = await makeProduct(app, { stock: 50, price: 2000 });
    await c.put(`/cart/items/${a.id}`, { qty: 2 });
    const order = (await c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() }))
      .body;
    expect(order.items).toHaveLength(1);
    expect(order.total).toBe(2000);
    await c.put(`/cart/items/${b.id}`, { qty: 1 }); // added after: untouched by the finished order
    expect((await c.get('/cart')).body.lines.map((l: any) => l.productId)).toEqual([b.id]);
  });
});

describe('Idempotency-Key means "this exact request"', () => {
  const placeKeyed = async (
    c: Client,
    key: string,
    body: Record<string, unknown>,
    productId: string,
  ) => {
    await c.put(`/cart/items/${productId}`, { qty: 1 });
    return c.post('/orders', body, { key });
  };

  it('the same key with the same request returns the same order (a real retry)', async () => {
    const c = await newClient(app, 'customer');
    const p = await makeProduct(app, { stock: 50 });
    const key = randomUUID();
    const first = await placeKeyed(
      c,
      key,
      { deliveryMethod: 'courier', address: COURIER_ADDRESS },
      p.id,
    );
    expect(first.status).toBe(201);
    // the same address spelled with the keys in another order and padded with spaces
    const reordered = {
      postalCode: ` ${COURIER_ADDRESS.postalCode} `,
      building: COURIER_ADDRESS.building,
      street: COURIER_ADDRESS.street,
      city: COURIER_ADDRESS.city,
      phone: COURIER_ADDRESS.phone,
      fullName: COURIER_ADDRESS.fullName,
    };
    const again = await c.post(
      '/orders',
      { deliveryMethod: 'courier', address: reordered },
      { key },
    );
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });

  it('the same key with ANOTHER delivery method or address is a 409 idempotency_conflict, and nothing is created', async () => {
    const c = await newClient(app, 'customer');
    const p = await makeProduct(app, { stock: 50 });
    const key = randomUUID();
    const first = await placeKeyed(c, key, { deliveryMethod: 'pickup' }, p.id);
    expect(first.status).toBe(201);

    for (const body of [
      { deliveryMethod: 'courier', address: COURIER_ADDRESS }, // pickup -> courier
      { deliveryMethod: 'courier', address: { ...COURIER_ADDRESS, street: 'Another street' } },
    ]) {
      const r = await c.post('/orders', body, { key });
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect(r.body.error.code).toBe('idempotency_conflict');
    }
    const orders = (await c.get('/orders?limit=50')).body.items;
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe(first.body.id);
  });

  it('courier first, then pickup or a changed address with the same key: also refused', async () => {
    const c = await newClient(app, 'customer');
    const p = await makeProduct(app, { stock: 50 });
    const key = randomUUID();
    expect(
      (await placeKeyed(c, key, { deliveryMethod: 'courier', address: COURIER_ADDRESS }, p.id))
        .status,
    ).toBe(201);
    expect((await c.post('/orders', { deliveryMethod: 'pickup' }, { key })).status).toBe(409);
    const changed = await c.post(
      '/orders',
      { deliveryMethod: 'courier', address: { ...COURIER_ADDRESS, building: '99' } },
      { key },
    );
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('idempotency_conflict');
  });

  it('a key belongs to ONE customer: the same key used by another customer makes their own order', async () => {
    const [a, b] = [await newClient(app, 'customer'), await newClient(app, 'customer')];
    const p = await makeProduct(app, { stock: 50 });
    const key = randomUUID();
    const first = await placeKeyed(a, key, { deliveryMethod: 'pickup' }, p.id);
    const second = await placeKeyed(b, key, { deliveryMethod: 'pickup' }, p.id);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });

  it('twenty parallel requests with one key still make exactly one order (the conflict check does not break the race handling)', async () => {
    const c = await newClient(app, 'customer');
    const p = await makeProduct(app, { stock: 50 });
    await c.put(`/cart/items/${p.id}`, { qty: 1 });
    const key = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => c.post('/orders', { deliveryMethod: 'pickup' }, { key })),
    );
    for (const r of rs) expect([200, 201]).toContain(r.status);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    void placeOrder;
  });
});
