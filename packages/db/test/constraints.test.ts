import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { runMigrations } from '../src/migrate';
import * as t from '../src/schema';
import { mkOrder, mkProduct, mkUser, sqlState } from './helpers';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.drop();
});

const CHECK = '23514';
const UNIQUE = '23505';
const FK = '23503';

describe('migrations', () => {
  it('are idempotent: running them again changes nothing', async () => {
    await runMigrations(tdb.db);
    await runMigrations(tdb.db);
    const r = await tdb.db.execute<{ last: number }>(sql`SELECT last FROM order_counter`);
    expect(r.rows).toEqual([{ last: 10233 }]);
  });

  it('create every table the application needs', async () => {
    const r = await tdb.db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
    );
    const names = new Set(r.rows.map((x) => x.table_name));
    for (const n of [
      'users',
      'sessions',
      'categories',
      'products',
      'carts',
      'cart_items',
      'promo_codes',
      'promo_redemptions',
      'orders',
      'order_items',
      'order_events',
      'payments',
      'payment_events',
      'refunds',
      'returns',
      'return_items',
      'jobs',
      'rate_limits',
      'order_counter',
    ]) {
      expect(names.has(n), n).toBe(true);
    }
  });
});

describe('data integrity is enforced by the database itself', () => {
  it('stock can never be negative, price must be positive', async () => {
    const p = await mkProduct(tdb.db, { stock: 1 });
    expect(
      await sqlState(() => tdb.db.execute(sql`UPDATE products SET stock = -1 WHERE id = ${p.id}`)),
    ).toBe(CHECK);
    expect(
      await sqlState(() => tdb.db.execute(sql`UPDATE products SET price = 0 WHERE id = ${p.id}`)),
    ).toBe(CHECK);
  });

  it('e-mails are unique and must be lower case', async () => {
    await mkUser(tdb.db, 'dup@x.test');
    expect(await sqlState(() => mkUser(tdb.db, 'dup@x.test'))).toBe(UNIQUE);
    expect(await sqlState(() => mkUser(tdb.db, 'Upper@x.test'))).toBe(CHECK);
  });

  it('promo codes: unique, upper-case, percent <= 100, used never above max_uses', async () => {
    const base = { type: 'percent' as const, value: 10 };
    await tdb.db.insert(t.promoCodes).values({ ...base, code: 'ABC', maxUses: 1 });
    expect(await sqlState(() => tdb.db.insert(t.promoCodes).values({ ...base, code: 'ABC' }))).toBe(
      UNIQUE,
    );
    expect(
      await sqlState(() => tdb.db.insert(t.promoCodes).values({ ...base, code: 'abc2' })),
    ).toBe(CHECK);
    expect(
      await sqlState(() =>
        tdb.db.insert(t.promoCodes).values({ type: 'percent', value: 101, code: 'BIG' }),
      ),
    ).toBe(CHECK);
    expect(
      await sqlState(() => tdb.db.execute(sql`UPDATE promo_codes SET used = 2 WHERE code = 'ABC'`)),
    ).toBe(CHECK);
    expect(
      await sqlState(() =>
        tdb.db.execute(sql`UPDATE promo_codes SET used = -1 WHERE code = 'ABC'`),
      ),
    ).toBe(CHECK);
  });

  it('orders: total formula, refunds bound, unique number and idempotency key', async () => {
    const u = await mkUser(tdb.db);
    expect(
      await sqlState(() =>
        mkOrder(tdb.db, u.id, { subtotal: 1000, discount: 100, delivery: 0, total: 1000 }),
      ),
    ).toBe(CHECK);
    expect(
      await sqlState(() =>
        mkOrder(tdb.db, u.id, { subtotal: 1000, discount: 2000, delivery: 0, total: -1000 }),
      ),
    ).toBe(CHECK);
    const o = await mkOrder(tdb.db, u.id, { number: 777_001 });
    expect(await sqlState(() => mkOrder(tdb.db, u.id, { number: 777_001 }))).toBe(UNIQUE);
    expect(await sqlState(() => mkOrder(tdb.db, u.id, { idempotencyKey: o.idempotencyKey }))).toBe(
      UNIQUE,
    );
    // the same key is fine for ANOTHER customer
    const u2 = await mkUser(tdb.db);
    expect(
      await sqlState(() => mkOrder(tdb.db, u2.id, { idempotencyKey: o.idempotencyKey })),
    ).toBeUndefined();
    expect(
      await sqlState(() =>
        tdb.db.execute(sql`UPDATE orders SET refunded_total = ${o.total + 1} WHERE id = ${o.id}`),
      ),
    ).toBe(CHECK);
  });

  it('order items: returned_qty <= qty, discount share <= line value', async () => {
    const u = await mkUser(tdb.db);
    const p = await mkProduct(tdb.db);
    const o = await mkOrder(tdb.db, u.id);
    const item = { orderId: o.id, productId: p.id, name: 'x', qty: 2, unitPrice: 500 };
    expect(
      await sqlState(() => tdb.db.insert(t.orderItems).values({ ...item, returnedQty: 3 })),
    ).toBe(CHECK);
    expect(
      await sqlState(() => tdb.db.insert(t.orderItems).values({ ...item, discountShare: 1001 })),
    ).toBe(CHECK);
    expect(await sqlState(() => tdb.db.insert(t.orderItems).values({ ...item, qty: 0 }))).toBe(
      CHECK,
    );
    expect(
      await sqlState(() =>
        tdb.db.insert(t.orderItems).values({ ...item, discountShare: 1000, returnedQty: 2 }),
      ),
    ).toBeUndefined();
  });

  it('a promo can be redeemed once per customer (when flagged) but different customers may share it', async () => {
    const [promo] = await tdb.db
      .insert(t.promoCodes)
      .values({ code: 'ONCE', type: 'fixed', value: 100 })
      .returning();
    const [a, b] = [await mkUser(tdb.db), await mkUser(tdb.db)];
    const mk = async (userId: string, once: boolean) => {
      const o = await mkOrder(tdb.db, userId);
      return tdb.db
        .insert(t.promoRedemptions)
        .values({ promoId: promo!.id, userId, orderId: o.id, oncePerCustomer: once });
    };
    await mk(a.id, true);
    expect(await sqlState(() => mk(a.id, true))).toBe(UNIQUE);
    expect(await sqlState(() => mk(b.id, true))).toBeUndefined();
    // customers flagged "not once" can redeem repeatedly
    expect(await sqlState(() => mk(a.id, false))).toBeUndefined();
    expect(await sqlState(() => mk(a.id, false))).toBeUndefined();
  });

  it('foreign keys: no order lines for unknown products, no orders for unknown users', async () => {
    const u = await mkUser(tdb.db);
    const o = await mkOrder(tdb.db, u.id);
    expect(
      await sqlState(() =>
        tdb.db
          .insert(t.orderItems)
          .values({ orderId: o.id, productId: randomUUID(), name: 'x', qty: 1, unitPrice: 1 }),
      ),
    ).toBe(FK);
    expect(await sqlState(() => mkOrder(tdb.db, randomUUID()))).toBe(FK);
  });

  it('webhook event ids are unique (idempotency primitive)', async () => {
    const id = randomUUID();
    await tdb.db.insert(t.paymentEvents).values({ eventId: id, type: 'payment.succeeded' });
    expect(
      await sqlState(() =>
        tdb.db.insert(t.paymentEvents).values({ eventId: id, type: 'payment.succeeded' }),
      ),
    ).toBe(UNIQUE);
    const r = await tdb.db
      .insert(t.paymentEvents)
      .values({ eventId: id, type: 'x' })
      .onConflictDoNothing()
      .returning();
    expect(r).toHaveLength(0);
  });

  it('order_counter is a single row table', async () => {
    expect(await sqlState(() => tdb.db.insert(t.orderCounter).values({ id: 2, last: 1 }))).toBe(
      CHECK,
    );
  });
});
