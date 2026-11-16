/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely typed JSON responses */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@shop/db';
import { containsNul } from '../src/http/zod.pipe';
import { pgErrorCode } from '../src/http/error.filter';
import { startTestApp, type TestApp } from './harness';
import { anon, newClient, type Client } from './shop';

let app: TestApp;
let manager: Client;
let customer: Client;
let categoryId: string;

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
  const [c] = await app.tdb.db
    .insert(schema.categories)
    .values({ name: 'C', slug: 'c' })
    .returning();
  categoryId = c!.id;
});
afterAll(async () => app.close());

describe('containsNul (what the validation pipe uses)', () => {
  it('finds NUL in strings, array items, nested values and object KEYS at any depth', () => {
    expect(containsNul('a\u0000b')).toBe(true);
    expect(containsNul({ a: ['x', { b: 'y\u0000' }] })).toBe(true);
    expect(containsNul({ ['k\u0000']: 1 })).toBe(true);
    expect(containsNul({ a: 'fine', b: [1, 2, null, true], c: { d: 'ok' } })).toBe(false);
    expect(containsNul(null)).toBe(false);
    expect(containsNul(42)).toBe(false);
  });
  it('a 200 000-level nested value neither overflows the stack nor takes long', () => {
    let deep: unknown = 'x\u0000';
    for (let i = 0; i < 200_000; i++) deep = [deep];
    const t = Date.now();
    expect(containsNul(deep)).toBe(true);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('pgErrorCode', () => {
  it('finds the SQLSTATE on the error itself or on a wrapped cause', () => {
    expect(pgErrorCode({ code: '22021' })).toBe('22021');
    expect(pgErrorCode(new Error('wrapped', { cause: { code: '22P02' } }))).toBe('22P02');
    expect(pgErrorCode(new Error('plain'))).toBeUndefined();
    expect(pgErrorCode({ code: 'ENOENT' })).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
  });
});

describe('the NUL character (PostgreSQL cannot store it) is a 400 on every input path, never a 500', () => {
  const NUL = 'a\u0000b';

  it('JSON body fields: product, promo, login, cart promo, address', async () => {
    const results = [
      await manager.post('/products', { name: NUL, categoryId, price: 100, stock: 1 }),
      await manager.post('/promos', { code: 'NUL\u0000X', type: 'percent', value: 5 }),
      await anon(app).post('/auth/login', { email: 'a\u0000@b.co', password: 'x\u0000y' }),
      await customer.post('/cart/promo', { code: NUL }),
      await customer.post('/orders', {
        deliveryMethod: 'courier',
        idempotencyKey: '6f1c2a54-6a45-4d1c-9a62-0d3f4c1b2a10',
        address: {
          fullName: NUL,
          phone: '+380501234567',
          city: 'Kyiv',
          street: 'Str',
          building: '1',
          postalCode: '01001',
        },
      }),
    ];
    for (const r of results) {
      expect(r.status, JSON.stringify(r.body).slice(0, 120)).toBe(400);
      expect((r.body as any).error.code).toBe('validation_error');
    }
    // nothing was stored
    const rows = await app.tdb.db.select().from(schema.products);
    expect(rows.some((p) => p.name.includes('\u0000'))).toBe(false);
  });

  it('a NUL in an object KEY of the body is refused too', async () => {
    const r = await manager.post('/products', {
      ['na\u0000me']: 'x',
      categoryId,
      price: 100,
      stock: 1,
    });
    expect(r.status).toBe(400);
  });

  it('query strings: product search, manager order search, category, cursor', async () => {
    for (const path of [
      '/products?q=%00',
      '/products?q=a%00b',
      '/products?category=%00',
      '/products?cursor=%00',
    ]) {
      const r = await anon(app).get(path);
      expect(r.status, path).toBe(400);
    }
    expect((await manager.get('/orders?q=%00')).status).toBe(400);
  });

  it('normal input still works (the check does not reject legitimate text)', async () => {
    const r = await manager.post('/products', {
      name: 'Кава «Арабіка» 🙂 100% \\ \' "',
      categoryId,
      price: 100,
      stock: 1,
    });
    expect(r.status).toBe(201);
    expect((await anon(app).get('/products?q=%25')).status).toBe(200);
  });
});

describe('report dates must be real calendar days', () => {
  it('2026-02-30, 2026-04-31 and 2025-02-29 are refused (they used to roll over into the next month)', async () => {
    for (const [from, to] of [
      ['2026-02-30', '2026-03-05'],
      ['2026-03-01', '2026-04-31'],
      ['2025-02-29', '2025-03-05'],
      ['2026-00-10', '2026-01-10'],
    ]) {
      const r = await manager.get(`/reports/sales?from=${from}&to=${to}`);
      expect(r.status, `${from}..${to}`).toBe(400);
    }
    // a real leap day is fine
    expect((await manager.get('/reports/sales?from=2024-02-29&to=2024-03-01')).status).toBe(200);
  });
  it('the same rule applies to the order list filters', async () => {
    expect((await manager.get('/orders?from=2026-02-30')).status).toBe(400);
    expect((await manager.get('/orders?from=2026-02-28&to=2026-03-01')).status).toBe(200);
  });
});

describe('the cart tells the client how long a reservation lasts', () => {
  it('reservationMinutes is the server setting (the checkout page used to say "15" regardless)', async () => {
    const r = await customer.get('/cart');
    expect(r.status).toBe(200);
    expect(r.body.reservationMinutes).toBe(15); // RESERVATION_MINUTES default of the test app
  });
});
