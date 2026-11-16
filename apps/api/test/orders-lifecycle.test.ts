import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@shop/db';
import { startTestApp, type TestApp } from './harness';
import {
  anon,
  drainJobs,
  getOrder,
  makeProduct,
  makePromo,
  newClient,
  payOrder,
  placeOrder,
  stockOf,
  type Client,
} from './shop';

/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely typed JSON responses */
let app: TestApp;
let manager: Client;
beforeAll(async () => {
  // sessions must outlive the clock jumps below (14-day return window)
  app = await startTestApp({
    env: { API_RATE_MAX_PER_IP: '1000000', SESSION_TTL_HOURS: '100000' },
  });
  manager = await newClient(app, 'manager');
});
afterAll(async () => app.close());

async function deliveredOrder(
  c: Client,
  items: { productId: string; qty: number }[],
  o: Parameters<typeof placeOrder>[2] = {},
) {
  const r = await placeOrder(c, items, o);
  expect(r.status).toBe(201);
  await payOrder(app, c, r.body.id);
  expect((await manager.patch(`/orders/${r.body.id}/status`, { status: 'shipped' })).status).toBe(
    200,
  );
  expect((await manager.patch(`/orders/${r.body.id}/status`, { status: 'delivered' })).status).toBe(
    200,
  );
  return getOrder(c, r.body.id);
}

describe('status transitions (manager)', () => {
  it('paid -> shipped -> delivered, with timestamps and history', async () => {
    const p = await makeProduct(app);
    const c = await newClient(app);
    const r = await placeOrder(c, [{ productId: p.id, qty: 1 }]);
    await payOrder(app, c, r.body.id);
    const shipped = await manager.patch(`/orders/${r.body.id}/status`, { status: 'shipped' });
    expect(shipped.body).toMatchObject({ status: 'shipped', customerEmail: c.email });
    expect(shipped.body.shippedAt).not.toBeNull();
    const delivered = await manager.patch(`/orders/${r.body.id}/status`, { status: 'delivered' });
    expect(delivered.body.status).toBe('delivered');
    expect(delivered.body.returnableUntil).toBe(
      new Date(app.clock.now().getTime() + 14 * 86_400_000).toISOString(),
    );
    expect(delivered.body.events.map((e: any) => e.type)).toEqual([
      'created',
      'paid',
      'shipped',
      'delivered',
    ]);
  });

  it('every other transition is refused with 409 and changes nothing', async () => {
    const p = await makeProduct(app, { stock: 50 });
    const c = await newClient(app);
    const unpaid = (await placeOrder(c, [{ productId: p.id, qty: 1 }])).body;
    const paid = (await placeOrder(c, [{ productId: p.id, qty: 1 }])).body;
    await payOrder(app, c, paid.id);
    const cancelled = (await placeOrder(c, [{ productId: p.id, qty: 1 }])).body;
    await c.post(`/orders/${cancelled.id}/cancel`);
    const delivered = await deliveredOrder(c, [{ productId: p.id, qty: 1 }]);
    const attempts: [string, string, string][] = [
      [unpaid.id, 'shipped', 'awaiting_payment'],
      [unpaid.id, 'delivered', 'awaiting_payment'],
      [paid.id, 'delivered', 'paid'],
      [cancelled.id, 'shipped', 'cancelled'],
      [delivered.id, 'shipped', 'delivered'],
      [delivered.id, 'delivered', 'delivered'],
    ];
    for (const [id, target, current] of attempts) {
      const r = await manager.patch(`/orders/${id}/status`, { status: target });
      expect(r.status, `${current} -> ${target}`).toBe(409);
      expect(r.body.error.code).toBe('invalid_transition');
      expect((await getOrder(manager, id)).status).toBe(current);
    }
    for (const bad of ['cancelled', 'paid', 'awaiting_payment', 'nope', '', null, 5]) {
      expect(
        (await manager.patch(`/orders/${paid.id}/status`, { status: bad })).status,
        String(bad),
      ).toBe(400);
    }
    expect(
      (await manager.patch(`/orders/${randomUUID()}/status`, { status: 'shipped' })).status,
    ).toBe(404);
  });

  it('two managers shipping the same order at once: one wins, the other gets 409', async () => {
    const p = await makeProduct(app);
    const c = await newClient(app);
    const r = await placeOrder(c, [{ productId: p.id, qty: 1 }]);
    await payOrder(app, c, r.body.id);
    const m2 = await newClient(app, 'manager');
    const rs = await Promise.all([
      manager.patch(`/orders/${r.body.id}/status`, { status: 'shipped' }),
      m2.patch(`/orders/${r.body.id}/status`, { status: 'shipped' }),
    ]);
    expect(rs.map((x) => x.status).sort()).toEqual([200, 409]);
  });

  it('customers cannot change statuses', async () => {
    const p = await makeProduct(app);
    const c = await newClient(app);
    const r = await placeOrder(c, [{ productId: p.id, qty: 1 }]);
    await payOrder(app, c, r.body.id);
    expect((await c.patch(`/orders/${r.body.id}/status`, { status: 'shipped' })).status).toBe(403);
    expect(
      (await anon(app).patch(`/orders/${r.body.id}/status`, { status: 'shipped' })).status,
    ).toBe(401);
    expect((await getOrder(c, r.body.id)).status).toBe('paid');
  });
});

describe('returns of part of an order', () => {
  it("7% discount over 3 items, one item returned: refund = that item's price minus ITS discount share, to the kopeck", async () => {
    const [a, b, d] = await Promise.all([
      makeProduct(app, { price: 3333, stock: 9 }),
      makeProduct(app, { price: 1999, stock: 9 }),
      makeProduct(app, { price: 12_345, stock: 9 }),
    ]);
    await makePromo(app, { code: 'SEVEN7', type: 'percent', value: 7 });
    const c = await newClient(app);
    const o = await deliveredOrder(
      c,
      [
        { productId: a.id, qty: 1 },
        { productId: b.id, qty: 3 },
        { productId: d.id, qty: 2 },
      ],
      { promo: 'SEVEN7', delivery: 'courier' },
    );
    expect(o).toMatchObject({ subtotal: 34_020, discount: 2381, delivery: 10_000, total: 41_639 });
    const line = (price: number) => o.items.find((i: any) => i.unitPrice === price);
    expect([
      line(3333).discountShare,
      line(1999).discountShare,
      line(12_345).discountShare,
    ]).toEqual([233, 420, 1728]);

    // return the whole 3 x 19.99 line: it was bought for 5997 - 420 = 5577
    const r1 = await c.post(`/orders/${o.id}/returns`, {
      items: [{ orderItemId: line(1999).id, qty: 3 }],
      reason: 'does not fit',
    });
    expect(r1.status).toBe(201);
    await drainJobs(app);
    let after = await getOrder(c, o.id);
    expect(after.refunds).toMatchObject([{ kind: 'return', amount: 5577, status: 'succeeded' }]);
    expect(after.refundedTotal).toBe(5577);
    expect(after.status).toBe('delivered');
    expect(after.items.find((i: any) => i.unitPrice === 1999).returnedQty).toBe(3);
    expect(await stockOf(app, b.id)).toBe(9); // 9 - 3 bought + 3 returned

    // return 1 of 2 of the expensive line: 24690 - 1728 = 22962 -> 11481 each
    await c.post(`/orders/${o.id}/returns`, { items: [{ orderItemId: line(12_345).id, qty: 1 }] });
    // and the cheap single item: 3333 - 233 = 3100
    await c.post(`/orders/${o.id}/returns`, { items: [{ orderItemId: line(3333).id, qty: 1 }] });
    await drainJobs(app);
    after = await getOrder(c, o.id);
    expect(after.refunds.map((x: any) => x.amount)).toEqual([5577, 11_481, 3100]);
    expect(after.refundedTotal).toBe(5577 + 11_481 + 3100);
    // delivery (100 ₴) is never refunded: the customer still paid for it
    expect(after.total - after.refundedTotal).toBeGreaterThanOrEqual(o.delivery);
    expect(
      after.events.map((e: any) => e.type).filter((t: string) => t === 'return_requested'),
    ).toHaveLength(3);
  });

  it('returning the rest of a line later refunds exactly the remainder: all returns add up to the line net', async () => {
    const p = await makeProduct(app, { price: 1000, stock: 20 });
    await makePromo(app, { code: 'THIRD', type: 'fixed', value: 100, oncePerCustomer: false });
    const c = await newClient(app);
    const o = await deliveredOrder(c, [{ productId: p.id, qty: 7 }], { promo: 'THIRD' }); // 7000 - 100 = 6900 net for 7 units
    const item = o.items[0];
    expect(item.net).toBe(6900);
    const amounts: number[] = [];
    for (const qty of [2, 3, 2]) {
      const r = await c.post(`/orders/${o.id}/returns`, { items: [{ orderItemId: item.id, qty }] });
      expect(r.status).toBe(201);
      amounts.push(r.body.refunds.at(-1).amount);
    }
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(6900);
    expect(amounts).toEqual([1971, 2957, 1972]); // floor(6900*k/7) cumulative: 1971, 4928, 6900
    expect((await getOrder(c, o.id)).refundedTotal).toBe(6900);
  });

  it('cannot return more than bought, across several returns and within one request', async () => {
    const p = await makeProduct(app, { price: 500, stock: 20 });
    const c = await newClient(app);
    const o = await deliveredOrder(c, [{ productId: p.id, qty: 3 }]);
    const id = o.items[0].id;
    const tooMany = await c.post(`/orders/${o.id}/returns`, {
      items: [{ orderItemId: id, qty: 4 }],
    });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error).toMatchObject({
      code: 'return_exceeds_purchased',
      details: { bought: 3, alreadyReturned: 0, requested: 4 },
    });
    expect(
      (await c.post(`/orders/${o.id}/returns`, { items: [{ orderItemId: id, qty: 2 }] })).status,
    ).toBe(201);
    const second = await c.post(`/orders/${o.id}/returns`, {
      items: [{ orderItemId: id, qty: 2 }],
    });
    expect(second.status).toBe(409);
    expect(second.body.error.details).toMatchObject({ alreadyReturned: 2, requested: 2 });
    expect(
      (await c.post(`/orders/${o.id}/returns`, { items: [{ orderItemId: id, qty: 1 }] })).status,
    ).toBe(201);
    expect(
      (await c.post(`/orders/${o.id}/returns`, { items: [{ orderItemId: id, qty: 1 }] })).status,
    ).toBe(409);
    expect((await getOrder(c, o.id)).refundedTotal).toBe(1500);
    expect(await stockOf(app, p.id)).toBe(20);
  });

  it('10 parallel return requests for the same units: the total never exceeds what was bought', async () => {
    const p = await makeProduct(app, { price: 700, stock: 30 });
    const c = await newClient(app);
    const o = await deliveredOrder(c, [{ productId: p.id, qty: 5 }]);
    const rs = await Promise.all(
      Array.from({ length: 10 }, () =>
        c.post(`/orders/${o.id}/returns`, { items: [{ orderItemId: o.items[0].id, qty: 2 }] }),
      ),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(2); // 2 + 2 = 4 of 5; a third request for 2 would exceed
    expect(
      rs
        .filter((r) => r.status === 409)
        .every((r) => r.body.error.code === 'return_exceeds_purchased'),
    ).toBe(true);
    const after = await getOrder(c, o.id);
    expect(after.items[0].returnedQty).toBe(4);
    expect(after.refundedTotal).toBe(2800);
    expect(await stockOf(app, p.id)).toBe(30 - 5 + 4);
  });

  it('14-day window: allowed on the last day, refused after', async () => {
    const p = await makeProduct(app, { stock: 10 });
    const c = await newClient(app);
    const o = await deliveredOrder(c, [{ productId: p.id, qty: 2 }]);
    app.clock.advance(14 * 86_400_000 - 1000);
    expect(
      (await c.post(`/orders/${o.id}/returns`, { items: [{ orderItemId: o.items[0].id, qty: 1 }] }))
        .status,
    ).toBe(201);
    app.clock.advance(2000);
    const late = await c.post(`/orders/${o.id}/returns`, {
      items: [{ orderItemId: o.items[0].id, qty: 1 }],
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('return_window_closed');
  });

  it("only delivered orders can be returned; not somebody else's; not with foreign / unknown / malformed items", async () => {
    const p = await makeProduct(app, { stock: 20 });
    const c = await newClient(app);
    const paid = (await placeOrder(c, [{ productId: p.id, qty: 1 }])).body;
    await payOrder(app, c, paid.id);
    const body = { items: [{ orderItemId: paid.items[0].id, qty: 1 }] };
    expect((await c.post(`/orders/${paid.id}/returns`, body)).status).toBe(409);
    const mine = await deliveredOrder(c, [{ productId: p.id, qty: 1 }]);
    const other = await newClient(app);
    expect(
      (
        await other.post(`/orders/${mine.id}/returns`, {
          items: [{ orderItemId: mine.items[0].id, qty: 1 }],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await c.post(`/orders/${mine.id}/returns`, {
          items: [{ orderItemId: paid.items[0].id, qty: 1 }],
        })
      ).status,
    ).toBe(422); // item of ANOTHER order
    expect(
      (
        await c.post(`/orders/${mine.id}/returns`, {
          items: [{ orderItemId: randomUUID(), qty: 1 }],
        })
      ).status,
    ).toBe(422);
    for (const bad of [
      { items: [] },
      { items: [{ orderItemId: 'x', qty: 1 }] },
      { items: [{ orderItemId: mine.items[0].id, qty: 0 }] },
      { items: [{ orderItemId: mine.items[0].id, qty: -1 }] },
      { items: 'all' },
      {},
    ]) {
      expect((await c.post(`/orders/${mine.id}/returns`, bad)).status, JSON.stringify(bad)).toBe(
        400,
      );
    }
    expect((await getOrder(c, mine.id)).refundedTotal).toBe(0);
  });

  it('an order that a 100% promo would make free is refused (a zero payment cannot exist) and nothing is reserved', async () => {
    const p = await makeProduct(app, { price: 1000, stock: 5 });
    await makePromo(app, { code: 'FREEBIE', type: 'percent', value: 100, oncePerCustomer: false });
    await makePromo(app, {
      code: 'HUGEOFF',
      type: 'fixed',
      value: 99_999_999,
      oncePerCustomer: false,
    });
    const c = await newClient(app);
    for (const code of ['FREEBIE', 'HUGEOFF']) {
      const r = await placeOrder(c, [{ productId: p.id, qty: 1 }], { promo: code });
      expect(r.status, code).toBe(422);
      expect(r.body.error.code).toBe('validation_error');
    }
    expect(await stockOf(app, p.id)).toBe(5);
    expect(
      (
        await app.tdb.db
          .select()
          .from(schema.promoCodes)
          .where(eq(schema.promoCodes.code, 'FREEBIE'))
      )[0]!.used,
    ).toBe(0);
  });
});

describe('who can see and touch which order (IDOR / access control)', () => {
  it("customers see only their own orders; a stranger's id looks like a missing order", async () => {
    const p = await makeProduct(app, { stock: 20 });
    const [alice, mallory] = [await newClient(app), await newClient(app)];
    const mine = (await placeOrder(alice, [{ productId: p.id, qty: 1 }])).body;
    const theirs = (await placeOrder(mallory, [{ productId: p.id, qty: 1 }])).body;
    expect((await alice.get(`/orders/${mine.id}`)).status).toBe(200);
    expect((await mallory.get(`/orders/${mine.id}`)).status).toBe(404);
    expect((await mallory.post(`/orders/${mine.id}/cancel`)).status).toBe(404);
    expect((await mallory.post(`/orders/${mine.id}/pay`, {})).status).toBe(404);
    expect((await getOrder(alice, mine.id)).status).toBe('awaiting_payment');
    const list = await alice.get('/orders');
    expect(list.body.items.map((o: any) => o.id)).toEqual([mine.id]);
    expect(list.body.items[0].customerEmail).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain(theirs.id);
    // filters cannot widen the scope
    expect(
      (await alice.get(`/orders?q=${theirs.number}`)).body.items.map((o: any) => o.id),
    ).toEqual([mine.id]);
    expect((await manager.get(`/orders/${mine.id}`)).status).toBe(200);
  });

  it('anonymous users get 401 everywhere; malformed ids 400', async () => {
    const a = anon(app);
    for (const [m, path] of [
      ['get', '/orders'],
      ['get', `/orders/${randomUUID()}`],
      ['post', `/orders/${randomUUID()}/cancel`],
      ['post', `/orders/${randomUUID()}/returns`],
      ['get', '/reports/sales?from=2026-01-01&to=2026-01-02'],
      ['get', '/promos'],
      ['post', '/promos'],
    ] as const) {
      expect(((await (a as any)[m](path)) as any).status, `${m} ${path}`).toBe(401);
    }
    const c = await newClient(app);
    expect((await c.get('/orders/not-a-uuid')).status).toBe(400);
    expect((await c.get(`/orders/${randomUUID()}`)).status).toBe(404);
  });

  it('customers are refused on every manager endpoint (direct requests)', async () => {
    const c = await newClient(app);
    const id = randomUUID();
    const checks = [
      c.get('/reports/sales?from=2026-01-01&to=2026-01-02'),
      c.get('/promos'),
      c.get(`/promos/${id}`),
      c.post('/promos', { code: 'HACK', type: 'percent', value: 99 }),
      c.patch(`/promos/${id}`, { active: false }),
      c.del(`/promos/${id}`),
      c.patch(`/orders/${id}/status`, { status: 'shipped' }),
    ];
    for (const r of await Promise.all(checks)) expect(r.status).toBe(403);
  });

  it('managers cannot shop (cart, checkout, cancel, return, pay are customer actions)', async () => {
    const id = randomUUID();
    for (const r of await Promise.all([
      manager.get('/cart'),
      manager.post(`/orders/${id}/cancel`),
      manager.post(`/orders/${id}/returns`, { items: [{ orderItemId: id, qty: 1 }] }),
      manager.post(`/orders/${id}/pay`, {}),
    ])) {
      expect(r.status).toBe(403);
    }
  });
});

describe('manager: order list, promo CRUD and sales report', () => {
  it('list: filter by status and by period, search by number / e-mail, keyset pagination without gaps', async () => {
    const local = await startTestApp({ env: { API_RATE_MAX_PER_IP: '1000000' } });
    try {
      const m = await newClient(local, 'manager');
      const c = await newClient(local);
      const p = await makeProduct(local, { stock: 500, price: 100 });
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        local.clock.advance(3_600_000); // one hour apart
        const r = await placeOrder(await newClient(local), [{ productId: p.id, qty: 1 }]);
        ids.push(r.body.id);
        if (i % 3 === 0) {
          const k = r.body;
          await local.tdb.db
            .update(schema.orders)
            .set({ status: 'cancelled', cancelReason: 'customer', reservedUntil: null })
            .where(eq(schema.orders.id, k.id));
        }
      }
      void c;
      const all: string[] = [];
      let cursor: string | null = null;
      do {
        const r: any = await m.get(`/orders?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
        all.push(...r.body.items.map((o: any) => o.id));
        cursor = r.body.nextCursor;
      } while (cursor);
      expect(all).toEqual([...ids].reverse());
      const cancelled = await m.get('/orders?status=cancelled&limit=50');
      expect(cancelled.body.items).toHaveLength(4);
      expect(cancelled.body.items[0].customerEmail).toContain('@');
      const day = local.clock.now().toISOString().slice(0, 10);
      expect(
        (await m.get(`/orders?from=${day}&to=${day}&limit=50`)).body.items.length,
      ).toBeGreaterThan(0);
      expect((await m.get('/orders?from=2020-01-01&to=2020-01-02')).body.items).toHaveLength(0);
      const first = await m.get(`/orders/${ids[0]}`);
      expect(
        (await m.get(`/orders?q=${first.body.number}`)).body.items.map((o: any) => o.id),
      ).toEqual([ids[0]]);
      expect(
        (await m.get(`/orders?q=${encodeURIComponent(first.body.customerEmail)}`)).body.items.map(
          (o: any) => o.id,
        ),
      ).toEqual([ids[0]]);
      for (const bad of [
        '?status=hacked',
        '?from=yesterday',
        '?from=2026-02-01&to=2026-01-01',
        '?limit=0',
        '?cursor=zzz',
        `?cursor=${Buffer.from('{"c":"x","id":"y"}').toString('base64url')}`,
      ]) {
        expect((await m.get(`/orders${bad}`)).status, bad).toBe(400);
      }
    } finally {
      await local.close();
    }
  });

  it('promo CRUD: create, case-insensitive uniqueness, edit, usage counter, delete vs deactivate', async () => {
    const created = await manager.post('/promos', {
      code: 'Summer25',
      type: 'percent',
      value: 25,
      minOrder: 50_000,
      maxUses: 3,
      expiresAt: '2030-01-01T00:00:00Z',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      code: 'SUMMER25',
      type: 'percent',
      value: 25,
      minOrder: 50_000,
      maxUses: 3,
      used: 0,
      oncePerCustomer: true,
      active: true,
    });
    expect(
      (await manager.post('/promos', { code: 'summer25', type: 'fixed', value: 1 })).status,
    ).toBe(409);
    expect(
      (await manager.patch(`/promos/${created.body.id}`, { maxUses: 10, active: false })).body,
    ).toMatchObject({ maxUses: 10, active: false });

    const p = await makeProduct(app, { price: 100_000, stock: 5 });
    await manager.patch(`/promos/${created.body.id}`, { active: true });
    const c = await newClient(app);
    await placeOrder(c, [{ productId: p.id, qty: 1 }], { promo: 'summer25' });
    const used = await manager.get(`/promos/${created.body.id}`);
    expect(used.body.used).toBe(1);
    expect((await manager.patch(`/promos/${created.body.id}`, { maxUses: 0 })).status).toBe(400);
    expect(
      (await manager.patch(`/promos/${created.body.id}`, { startsAt: '2031-01-01T00:00:00Z' }))
        .status,
    ).toBe(422);
    // a code that appears in orders is deactivated, not deleted
    expect((await manager.del(`/promos/${created.body.id}`)).status).toBe(204);
    expect((await manager.get(`/promos/${created.body.id}`)).body.active).toBe(false);
    // a never-used code is really deleted
    const fresh = await manager.post('/promos', { code: 'NEVERUSED', type: 'fixed', value: 500 });
    expect((await manager.del(`/promos/${fresh.body.id}`)).status).toBe(204);
    expect((await manager.get(`/promos/${fresh.body.id}`)).status).toBe(404);
    expect((await manager.get('/promos')).body.some((x: any) => x.code === 'SUMMER25')).toBe(true);
  });

  it('promo validation rejects nonsense', async () => {
    const bad: unknown[] = [
      { code: 'AB', type: 'percent', value: 10 },
      { code: 'has space', type: 'percent', value: 10 },
      { code: 'OKAY', type: 'percent', value: 0 },
      { code: 'OKAY', type: 'percent', value: 101 },
      { code: 'OKAY', type: 'fixed', value: -5 },
      { code: 'OKAY', type: 'bogus', value: 5 },
      { code: 'OKAY', type: 'fixed', value: 5, maxUses: 0 },
      { code: 'OKAY', type: 'fixed', value: 5, minOrder: -1 },
      { code: 'OKAY', type: 'fixed', value: 5, expiresAt: 'tomorrow' },
      {
        code: 'OKAY',
        type: 'fixed',
        value: 5,
        startsAt: '2030-01-01T00:00:00Z',
        expiresAt: '2029-01-01T00:00:00Z',
      },
    ];
    for (const b of bad)
      expect((await manager.post('/promos', b)).status, JSON.stringify(b)).toBe(400);
  });

  it('sales report: revenue is net of returns and cancelled orders, counts and averages are right, period is validated', async () => {
    const local = await startTestApp({ env: { API_RATE_MAX_PER_IP: '1000000' } });
    try {
      const m = await newClient(local, 'manager');
      const a = await makeProduct(local, { name: 'Top seller', price: 10_000, stock: 100 });
      const b = await makeProduct(local, { name: 'Rare', price: 50_000, stock: 100 });
      const pay = async (c: Client, id: string) => {
        const { startPay, stubClick } = await import('./shop');
        await stubClick(local, await startPay(c, id), 'success');
      };
      const c1 = await newClient(local);
      const c2 = await newClient(local);
      const c3 = await newClient(local);
      const o1 = (await placeOrder(c1, [{ productId: a.id, qty: 3 }])).body; // 30000
      const o2 = (
        await placeOrder(c2, [
          { productId: b.id, qty: 1 },
          { productId: a.id, qty: 1 },
        ])
      ).body; // 60000
      const o3 = (await placeOrder(c3, [{ productId: b.id, qty: 2 }])).body; // 100000, will be cancelled
      for (const [c, o] of [
        [c1, o1],
        [c2, o2],
        [c3, o3],
      ] as const)
        await pay(c, o.id);
      await c3.post(`/orders/${o3.id}/cancel`);
      await m.patch(`/orders/${o1.id}/status`, { status: 'shipped' });
      await m.patch(`/orders/${o1.id}/status`, { status: 'delivered' });
      await c1.post(`/orders/${o1.id}/returns`, {
        items: [{ orderItemId: o1.items[0].id, qty: 1 }],
      }); // -10000
      await drainJobs(local);
      const day = local.clock.now().toISOString().slice(0, 10);
      const r = await m.get(`/reports/sales?from=${day}&to=${day}`);
      expect(r.status).toBe(200);
      expect(r.body.netRevenue).toBe(30_000 + 60_000 - 10_000);
      expect(r.body.orders).toBe(2); // o3 was cancelled and refunded
      expect(r.body.averageCheck).toBe(40_000);
      expect(r.body.byDay).toEqual([{ day, revenue: 80_000, orders: 2 }]);
      expect(r.body.topProducts[0]).toMatchObject({
        name: 'Top seller',
        units: 3,
        revenue: 30_000,
      }); // 3 + 1 - 1 returned
      expect(r.body.topProducts[1]).toMatchObject({ name: 'Rare', units: 1, revenue: 50_000 });
      expect((await m.get('/reports/sales?from=2020-01-01&to=2020-01-31')).body).toMatchObject({
        netRevenue: 0,
        orders: 0,
        averageCheck: 0,
        topProducts: [],
        byDay: [],
      });
      for (const bad of [
        '',
        '?from=2026-01-01',
        '?from=2026-02-01&to=2026-01-01',
        '?from=2020-01-01&to=2026-01-01',
        '?from=x&to=y',
        '?from=2026-13-01&to=2026-13-02',
      ]) {
        expect((await m.get(`/reports/sales${bad}`)).status, bad).toBe(400);
      }
    } finally {
      await local.close();
    }
  });
});
