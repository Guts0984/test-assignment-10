import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './harness';
import { makeProduct, newClient, placeOrder, stockOf, type Client } from './shop';

let app: TestApp;
let manager: Client;
let customer: Client;
beforeAll(async () => {
  app = await startTestApp({
    env: {
      API_RATE_MAX_PER_IP: '1000000',
      LOGIN_MAX_PER_IP: '100000',
      LOGIN_MAX_PER_IP_ACCOUNT: '100000',
    },
  });
  manager = await newClient(app, 'manager');
  customer = await newClient(app, 'customer');
});
afterAll(async () => app.close());

describe('a manager editing stock while customers reserve and cancel', () => {
  it('"+5" computed from a stale screen does not overwrite the reservation: 10 -> reserve 3 -> +5 -> cancel = 15 (not 18)', async () => {
    const p = await makeProduct(app, { stock: 10 });
    // the manager's screen shows 10 ...
    const order = (await placeOrder(customer, [{ productId: p.id, qty: 3 }])).body; // ... a customer reserves 3
    expect(await stockOf(app, p.id)).toBe(7);
    // ... and the manager saves what he saw plus 5, as a difference
    const saved = await manager.patch(`/products/${p.id}`, { stockDelta: 5 });
    expect(saved.status).toBe(200);
    expect(saved.body.stock).toBe(12);
    expect((await customer.post(`/orders/${order.id}/cancel`, {})).status).toBe(200);
    expect(await stockOf(app, p.id)).toBe(15);
  });

  it('saving only the name or price never touches the stock (a reservation made meanwhile survives)', async () => {
    const p = await makeProduct(app, { stock: 10 });
    await placeOrder(customer, [{ productId: p.id, qty: 4 }]);
    const r = await manager.patch(`/products/${p.id}`, { name: 'Renamed', price: 12345 });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Renamed');
    expect(await stockOf(app, p.id)).toBe(6);
  });

  it('a negative difference works, but never below zero or above the limit: 409 and nothing changes', async () => {
    const p = await makeProduct(app, { stock: 5 });
    expect((await manager.patch(`/products/${p.id}`, { stockDelta: -2 })).body.stock).toBe(3);
    const below = await manager.patch(`/products/${p.id}`, { stockDelta: -4 });
    expect(below.status).toBe(409);
    expect(below.body.error.code).toBe('conflict');
    expect(await stockOf(app, p.id)).toBe(3);
    expect((await manager.patch(`/products/${p.id}`, { stockDelta: 1_000_000 })).status).toBe(409);
    expect(await stockOf(app, p.id)).toBe(3);
  });

  it('ten parallel "+1" edits add up exactly (no lost update), racing with five checkouts', async () => {
    const p = await makeProduct(app, { stock: 20 });
    const buyers = await Promise.all(Array.from({ length: 5 }, () => newClient(app, 'customer')));
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => manager.patch(`/products/${p.id}`, { stockDelta: 1 })),
      ...buyers.map((b) => placeOrder(b, [{ productId: p.id, qty: 2 }])),
    ]);
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    expect(await stockOf(app, p.id)).toBe(20 + 10 - 5 * 2);
  });

  it('invalid combinations are refused: both stock and stockDelta, zero, floats, strings, missing product', async () => {
    const p = await makeProduct(app, { stock: 5 });
    for (const body of [
      { stock: 5, stockDelta: 1 },
      { stockDelta: 0 },
      { stockDelta: 1.5 },
      { stockDelta: '3' },
      { stockDelta: 2_000_000 },
      { stockDelta: null },
    ]) {
      const r = await manager.patch(`/products/${p.id}`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await manager.patch(`/products/${p.id}`, { stock: 9 })).body.stock).toBe(9); // exact recount still works
    const missing = await manager.patch('/products/6f1c2a54-6a45-4d1c-9a62-0d3f4c1b2a10', {
      stockDelta: 1,
    });
    expect(missing.status).toBe(404);
    expect(await stockOf(app, p.id)).toBe(9);
  });

  it('a customer cannot change stock at all', async () => {
    const p = await makeProduct(app, { stock: 5 });
    expect((await customer.patch(`/products/${p.id}`, { stockDelta: 100 })).status).toBe(403);
    expect(await stockOf(app, p.id)).toBe(5);
  });
});
