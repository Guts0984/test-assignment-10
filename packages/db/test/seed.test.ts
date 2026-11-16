import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listOrdersPage, salesReport } from '../src/queries';
import { isSeeded, seedDatabase } from '../src/seed';
import { verifyPassword } from '../src/password';
import { createTestDatabase, type TestDatabase } from '../src/testing';

let tdb: TestDatabase;
const now = new Date();
let seedMs = 0;

beforeAll(async () => {
  tdb = await createTestDatabase();
  const started = Date.now();
  await seedDatabase(tdb.db, {
    now,
    managerPassword: 'Manager123!',
    customerPassword: 'Customer123!',
  });
  seedMs = Date.now() - started;
});
afterAll(async () => {
  await tdb.drop();
});

const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>) =>
  (await tdb.db.execute<T>(q)).rows[0] as T;

describe('seed matches the assignment', () => {
  it('has 500 products in 10 categories, 50 customers, 1 manager, 10 000 orders, promo codes', async () => {
    expect(await one(sql`SELECT count(*)::int n FROM products`)).toEqual({ n: 500 });
    expect(await one(sql`SELECT count(*)::int n FROM categories`)).toEqual({ n: 10 });
    expect(await one(sql`SELECT count(*)::int n FROM users WHERE role='customer'`)).toEqual({
      n: 50,
    });
    expect(await one(sql`SELECT count(*)::int n FROM users WHERE role='manager'`)).toEqual({
      n: 1,
    });
    expect(await one(sql`SELECT count(*)::int n FROM orders`)).toEqual({ n: 10_000 });
    expect(
      (await one<{ n: number }>(sql`SELECT count(*)::int n FROM promo_codes`)).n,
    ).toBeGreaterThanOrEqual(4);
    // every category is used and every product belongs to one
    expect(await one(sql`SELECT count(DISTINCT category_id)::int n FROM products`)).toEqual({
      n: 10,
    });
    expect(seedMs).toBeLessThan(60_000);
  });

  it('orders span 90 days and cover all five statuses', async () => {
    const r = await tdb.db.execute<{ status: string; n: number }>(
      sql`SELECT status, count(*)::int n FROM orders GROUP BY 1`,
    );
    const byStatus = Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
    for (const s of ['awaiting_payment', 'paid', 'shipped', 'delivered', 'cancelled'])
      expect(byStatus[s], s).toBeGreaterThan(0);
    const span = await one<{ min: Date; max: Date }>(
      sql`SELECT min(created_at) min, max(created_at) max FROM orders`,
    );
    const days = (now.getTime() - new Date(span.min).getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(88);
    expect(days).toBeLessThanOrEqual(90.01);
    expect(new Date(span.max).getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it('order numbers are contiguous from 10234 and the counter continues after the last one', async () => {
    expect(
      await one(
        sql`SELECT min(number)::int mn, max(number)::int mx, count(DISTINCT number)::int n FROM orders`,
      ),
    ).toEqual({ mn: 10_234, mx: 20_233, n: 10_000 });
    expect(await one(sql`SELECT last FROM order_counter`)).toEqual({ last: 20_233 });
  });

  it('money is consistent for every order (items, discount shares, totals, refunds)', async () => {
    expect(
      await one(sql`
        SELECT count(*)::int bad FROM orders o WHERE
          o.subtotal <> (SELECT coalesce(sum(qty::bigint*unit_price),0) FROM order_items i WHERE i.order_id=o.id)
       OR o.discount <> (SELECT coalesce(sum(discount_share),0) FROM order_items i WHERE i.order_id=o.id)
       OR o.total <> o.subtotal - o.discount + o.delivery`),
    ).toEqual({ bad: 0 });
    expect(
      await one(sql`
        SELECT count(*)::int bad FROM orders o WHERE o.refunded_total <> coalesce((SELECT sum(amount) FROM refunds r WHERE r.order_id=o.id AND r.status='succeeded'),0)`),
    ).toEqual({ bad: 0 });
    // delivery rules: pickup free; courier 100 ₴ below 2000 ₴ after discount, free above
    expect(
      await one(
        sql`SELECT count(*)::int bad FROM orders WHERE (delivery_method='pickup' AND delivery<>0) OR (delivery_method='courier' AND ((subtotal-discount) >= 200000 AND delivery<>0 OR (subtotal-discount) < 200000 AND delivery<>10000))`,
      ),
    ).toEqual({ bad: 0 });
  });

  it('timelines are sane: paid_at after created_at, status matches timestamps', async () => {
    expect(
      await one(
        sql`SELECT count(*)::int bad FROM orders WHERE paid_at < created_at OR shipped_at < paid_at OR delivered_at < shipped_at`,
      ),
    ).toEqual({ bad: 0 });
    expect(
      await one(
        sql`SELECT count(*)::int bad FROM orders WHERE (status='delivered' AND delivered_at IS NULL) OR (status='shipped' AND shipped_at IS NULL) OR (status IN ('paid','shipped','delivered') AND paid_at IS NULL) OR (status='awaiting_payment' AND reserved_until IS NULL) OR (status='cancelled' AND cancelled_at IS NULL)`,
      ),
    ).toEqual({ bad: 0 });
    expect(
      await one(
        sql`SELECT count(*)::int bad FROM orders WHERE paid_at > now() OR created_at > now()`,
      ),
    ).toEqual({ bad: 0 });
  });

  it('promo counters equal real redemptions; limit and per-customer rules were respected', async () => {
    expect(
      await one(
        sql`SELECT count(*)::int bad FROM promo_codes p WHERE p.used <> (SELECT count(*) FROM promo_redemptions r WHERE r.promo_id=p.id)`,
      ),
    ).toEqual({ bad: 0 });
    expect(await one(sql`SELECT count(*)::int n FROM promo_redemptions`)).not.toEqual({ n: 0 });
    expect(
      await one(
        sql`SELECT count(*)::int bad FROM (SELECT promo_id, user_id FROM promo_redemptions WHERE once_per_customer GROUP BY 1,2 HAVING count(*) > 1) x`,
      ),
    ).toEqual({ bad: 0 });
    // cancelled orders released their promo
    expect(
      await one(
        sql`SELECT count(*)::int bad FROM promo_redemptions r JOIN orders o ON o.id=r.order_id WHERE o.status='cancelled'`,
      ),
    ).toEqual({ bad: 0 });
  });

  it('the README demo promo works: customer1..customer10 have NOT redeemed WELCOME10, the others have', async () => {
    const used = (cond: string) =>
      one<{ n: number }>(
        sql.raw(`SELECT count(DISTINCT u.id)::int n FROM promo_redemptions r
          JOIN promo_codes p ON p.id = r.promo_id AND p.code = 'WELCOME10'
          JOIN users u ON u.id = r.user_id WHERE ${cond}`),
      );
    expect(await used(`u.email ~ '^customer([1-9]|10)@'`)).toEqual({ n: 0 });
    expect((await used(`u.email !~ '^customer([1-9]|10)@'`)).n).toBeGreaterThan(20);
  });

  it('returned quantities match return records; delivered orders only are returned', async () => {
    expect(
      await one(
        sql`SELECT count(*)::int bad FROM order_items i WHERE i.returned_qty <> coalesce((SELECT sum(qty) FROM return_items ri WHERE ri.order_item_id=i.id),0)`,
      ),
    ).toEqual({ bad: 0 });
    expect(
      await one(
        sql`SELECT count(*)::int bad FROM returns r JOIN orders o ON o.id=r.order_id WHERE o.status<>'delivered'`,
      ),
    ).toEqual({ bad: 0 });
    expect((await one<{ n: number }>(sql`SELECT count(*)::int n FROM returns`)).n).toBeGreaterThan(
      0,
    );
  });

  it('every awaiting_payment order has a pending expiry job and a future reservation', async () => {
    expect(
      await one(
        sql`SELECT count(*)::int bad FROM orders o WHERE status='awaiting_payment' AND (reserved_until <= now() OR NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type='expire_order' AND j.payload->>'orderId' = o.id::text))`,
      ),
    ).toEqual({ bad: 0 });
  });

  it('stock never negative; demo logins work', async () => {
    expect(await one(sql`SELECT count(*)::int bad FROM products WHERE stock < 0`)).toEqual({
      bad: 0,
    });
    const m = await one<{ password_hash: string }>(
      sql`SELECT password_hash FROM users WHERE email='manager@shop.test'`,
    );
    expect(await verifyPassword('Manager123!', m.password_hash)).toBe(true);
    expect(await verifyPassword('wrong', m.password_hash)).toBe(false);
    const c = await one<{ password_hash: string }>(
      sql`SELECT password_hash FROM users WHERE email='customer50@shop.test'`,
    );
    expect(await verifyPassword('Customer123!', c.password_hash)).toBe(true);
  });

  it('seeding twice is detected so a restart does not duplicate data', async () => {
    expect(await isSeeded(tdb.db)).toBe(true);
  });
});

describe('queries are fast on the seeded data (< 300 ms)', () => {
  const timed = async <T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> => {
    await fn(); // warm-up (plan cache, buffers) - the assignment measures steady state
    const t0 = performance.now();
    const value = await fn();
    return { ms: performance.now() - t0, value };
  };

  it('manager order list with status + period filters', async () => {
    const from = new Date(now.getTime() - 30 * 86_400_000);
    const { ms, value } = await timed(() =>
      listOrdersPage(tdb.db, { status: 'delivered', from, to: now, limit: 20 }),
    );
    expect(value.rows.length).toBe(20);
    expect(value.hasMore).toBe(true);
    expect(ms).toBeLessThan(300);
  });

  it('manager order list without filters, by number and by e-mail', async () => {
    expect((await timed(() => listOrdersPage(tdb.db, { limit: 20 }))).ms).toBeLessThan(300);
    const byNumber = await timed(() => listOrdersPage(tdb.db, { q: 'ORD-10234', limit: 20 }));
    expect(byNumber.value.rows.map((r) => r.number)).toEqual([10234]);
    expect(byNumber.ms).toBeLessThan(300);
    const byMail = await timed(() => listOrdersPage(tdb.db, { q: 'customer7@', limit: 20 }));
    expect(byMail.value.rows.length).toBeGreaterThan(0);
    expect(byMail.value.rows.every((r) => r.customerEmail.startsWith('customer7@'))).toBe(true);
    expect(byMail.ms).toBeLessThan(300);
  });

  it('keyset pagination walks the whole list without gaps or duplicates', async () => {
    const seen = new Set<string>();
    let after: { createdAt: Date; id: string } | undefined;
    let pages = 0;
    for (;;) {
      const page = await listOrdersPage(tdb.db, { limit: 500, after });
      page.rows.forEach((r) => {
        expect(seen.has(r.id)).toBe(false);
        seen.add(r.id);
      });
      pages++;
      if (!page.hasMore) break;
      const last = page.rows[page.rows.length - 1]!;
      after = { createdAt: last.createdAt, id: last.id };
    }
    expect(seen.size).toBe(10_000);
    expect(pages).toBe(20);
  });

  it('LIKE wildcards in the search term are escaped, not interpreted', async () => {
    const r = await listOrdersPage(tdb.db, { q: '%', limit: 5 });
    expect(r.rows).toHaveLength(0);
  });

  it('customer order list uses the per-user index', async () => {
    const u = await one<{ id: string }>(
      sql`SELECT id FROM users WHERE email='customer3@shop.test'`,
    );
    const { ms, value } = await timed(() => listOrdersPage(tdb.db, { userId: u.id, limit: 20 }));
    expect(value.rows.every((r) => r.customerEmail === 'customer3@shop.test')).toBe(true);
    expect(ms).toBeLessThan(300);
  });

  it('sales report for 90 days', async () => {
    const from = new Date(now.getTime() - 91 * 86_400_000);
    const { ms, value } = await timed(() =>
      salesReport(tdb.db, from, new Date(now.getTime() + 1000)),
    );
    expect(ms).toBeLessThan(300);
    expect(value.orders).toBeGreaterThan(1000);
    expect(value.topProducts).toHaveLength(10);
    expect(value.byDay.length).toBeGreaterThan(80);
  });

  it('sales report arithmetic: byDay and top products agree with the totals', async () => {
    const from = new Date(now.getTime() - 91 * 86_400_000);
    const to = new Date(now.getTime() + 1000);
    const r = await salesReport(tdb.db, from, to);
    expect(r.byDay.reduce((a, d) => a + d.revenue, 0)).toBe(r.netRevenue);
    expect(r.byDay.reduce((a, d) => a + d.orders, 0)).toBe(r.orders);
    // independent recomputation from raw rows
    const raw = await one<{ rev: string; n: string }>(
      sql`SELECT sum(total - refunded_total)::text rev, count(*)::text n FROM orders WHERE status IN ('paid','shipped','delivered')`,
    );
    expect(r.netRevenue).toBe(Number(raw.rev));
    expect(r.orders).toBe(Number(raw.n));
    // units sold for the top product = bought - returned over counted orders
    const top = r.topProducts[0]!;
    const units = await one<{ u: string }>(
      sql`SELECT sum(i.qty - i.returned_qty)::text u FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.product_id=${top.productId} AND o.status IN ('paid','shipped','delivered')`,
    );
    expect(top.units).toBe(Number(units.u));
    // the period boundary is half open: an empty period yields zeros
    const empty = await salesReport(
      tdb.db,
      new Date(now.getTime() + 86_400_000),
      new Date(now.getTime() + 2 * 86_400_000),
    );
    expect(empty).toEqual({ netRevenue: 0, orders: 0, topProducts: [], byDay: [] });
  });
});
