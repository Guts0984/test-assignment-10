import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, seedDatabase, type TestDatabase } from '@shop/db';
import { startTestApp, sleep, type TestApp } from './harness';
import { getOrder, makeProduct, newClient, placeOrder, startPay, stubClick, stockOf } from './shop';

/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely typed JSON responses */
describe('background worker (real polling loop, no manual job running)', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp({
      env: { JOBS_ENABLED: 'true', JOBS_POLL_MS: '50', API_RATE_MAX_PER_IP: '1000000' },
    });
  });
  afterAll(async () => app.close());

  const waitFor = async (fn: () => Promise<boolean>, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await sleep(40);
    }
    return false;
  };

  it('cancels an unpaid order after 15 minutes and returns the stock', async () => {
    const p = await makeProduct(app, { stock: 3 });
    const c = await newClient(app);
    const o = await placeOrder(c, [{ productId: p.id, qty: 2 }]);
    expect(await stockOf(app, p.id)).toBe(1);
    app.clock.advance(15 * 60_000 + 1000);
    expect(await waitFor(async () => (await getOrder(c, o.body.id)).status === 'cancelled')).toBe(
      true,
    );
    expect(await stockOf(app, p.id)).toBe(3);
  });

  it('delivers the "success in 30 seconds" notification by itself when the time comes', async () => {
    const p = await makeProduct(app, { stock: 3 });
    const c = await newClient(app);
    const o = await placeOrder(c, [{ productId: p.id, qty: 1 }]);
    await stubClick(app, await startPay(c, o.body.id), 'success_delayed');
    await sleep(300);
    expect((await getOrder(c, o.body.id)).status).toBe('awaiting_payment');
    app.clock.advance(31_000);
    expect(await waitFor(async () => (await getOrder(c, o.body.id)).status === 'paid')).toBe(true);
  });

  it('refunds complete on their own: cancel a paid order and the refund becomes succeeded', async () => {
    const p = await makeProduct(app, { stock: 3 });
    const c = await newClient(app);
    const o = await placeOrder(c, [{ productId: p.id, qty: 1 }]);
    await stubClick(app, await startPay(c, o.body.id), 'success');
    await c.post(`/orders/${o.body.id}/cancel`);
    expect(
      await waitFor(async () => (await getOrder(c, o.body.id)).refunds[0]?.status === 'succeeded'),
    ).toBe(true);
  });
});

describe('speed on the seeded database (10 000 orders / 90 days): < 300 ms', () => {
  let tdb: TestDatabase;
  let app: TestApp;
  beforeAll(async () => {
    tdb = await createTestDatabase();
    await seedDatabase(tdb.db, {
      managerPassword: 'Manager123!',
      customerPassword: 'Customer123!',
    });
    app = await startTestApp({ tdb, env: { API_RATE_MAX_PER_IP: '1000000' } });
    app.clock.set(new Date());
  }, 120_000);
  afterAll(async () => {
    await app.app.close();
    await tdb.drop();
  });

  const timed = async (fn: () => Promise<{ status: number; body: any }>) => {
    await fn();
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = await fn();
      samples.push(performance.now() - t0);
      expect(r.status).toBe(200);
    }
    return Math.max(...samples);
  };

  it('manager order list with filters, and the report for 90 days', async () => {
    const m = await newClient(app, 'manager');
    const today = new Date().toISOString().slice(0, 10);
    const from90 = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    const from30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const list = await m.get(`/orders?status=delivered&from=${from30}&to=${today}&limit=20`);
    expect(list.body.items).toHaveLength(20);
    expect(
      await timed(() => m.get(`/orders?status=delivered&from=${from30}&to=${today}&limit=20`)),
    ).toBeLessThan(300);
    expect(await timed(() => m.get('/orders?limit=50'))).toBeLessThan(300);
    expect(
      await timed(() => m.get(`/orders?q=customer12@&from=${from90}&to=${today}`)),
    ).toBeLessThan(300);
    const report = await m.get(`/reports/sales?from=${from90}&to=${today}`);
    expect(report.body.orders).toBeGreaterThan(1000);
    expect(report.body.topProducts).toHaveLength(10);
    expect(await timed(() => m.get(`/reports/sales?from=${from90}&to=${today}`))).toBeLessThan(300);
  });

  it("the catalogue and a customer's own order list are fast too", async () => {
    const c = await (async () => {
      const { createSession } = await import('../src/auth/sessions');
      const { clientFor } = await import('./shop');
      const [u] = await tdb.db.query.users.findMany({
        where: (t, { eq }) => eq(t.email, 'customer5@shop.test'),
      });
      const s = await createSession(app.ctx, u!.id);
      return clientFor(app, u!.id, u!.email, `sid=${s.token}`);
    })();
    expect(await timed(() => c.get('/orders?limit=20'))).toBeLessThan(300);
    expect(
      await timed(() => c.get('/products?q=pro&sort=price_desc&minPrice=10000&limit=24')),
    ).toBeLessThan(300);
  });

  it('seeded logins work end to end', async () => {
    const { request } = await import('./harness');
    const m = await request(app, 'POST', '/auth/login', {
      body: { email: 'manager@shop.test', password: 'Manager123!' },
    });
    expect(m.status).toBe(200);
    const c = await request(app, 'POST', '/auth/login', {
      body: { email: 'customer1@shop.test', password: 'Customer123!' },
    });
    expect(c.status).toBe(200);
  });
});
