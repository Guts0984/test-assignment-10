/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely typed JSON responses */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@shop/db';
import { startTestApp, type TestApp } from './harness';
import { anon, makeProduct, newClient, type Client } from './shop';

let app: TestApp;
let manager: Client;
let customer: Client;
const NOISE = {
  API_RATE_MAX_PER_IP: '1000000',
  LOGIN_MAX_PER_IP: '100000',
  LOGIN_MAX_PER_IP_ACCOUNT: '100000',
};

beforeAll(async () => {
  app = await startTestApp({ env: NOISE });
  manager = await newClient(app, 'manager');
  customer = await newClient(app, 'customer');
});
afterAll(async () => app.close());

describe('catalogue', () => {
  let cat1: string;
  let cat2: string;
  beforeAll(async () => {
    const [a, b] = await app.tdb.db
      .insert(schema.categories)
      .values([
        { name: 'Alpha', slug: 'alpha' },
        { name: 'Beta', slug: 'beta' },
      ])
      .returning();
    cat1 = a!.id;
    cat2 = b!.id;
    // 30 products with distinct and DUPLICATE prices (the keyset must tie-break on id)
    for (let i = 0; i < 30; i++) {
      app.clock.advance(1000);
      await makeProduct(app, {
        name: `Widget ${String(i).padStart(2, '0')}${i % 7 === 0 ? ' special' : ''}`,
        price: 1000 + (i % 5) * 500,
        stock: 5,
        categoryId: i % 2 ? cat1 : cat2,
      });
    }
    await makeProduct(app, { name: 'Hidden thing', price: 777, categoryId: cat1, active: false });
  });

  const list = async (qs = '', c: Client = anon(app)) =>
    (await c.get(`/products${qs}`)).body as { items: any[]; nextCursor: string | null };

  it('is public, hides inactive products, and shows category and price', async () => {
    const r = await list('?limit=100');
    expect(r.items).toHaveLength(30);
    expect(r.items.some((p) => p.name === 'Hidden thing')).toBe(false);
    expect(r.items[0]).toMatchObject({
      categoryName: expect.any(String),
      price: expect.any(Number),
      stock: expect.any(Number),
      active: true,
    });
  });

  it('managers (only) can include inactive products; a customer asking for it gets the normal list', async () => {
    expect((await list('?limit=100&includeInactive=true', manager)).items).toHaveLength(31);
    expect((await list('?limit=100&includeInactive=true', customer)).items).toHaveLength(30);
    expect((await list('?limit=100&includeInactive=true')).items).toHaveLength(30);
  });

  it('filters: search (case-insensitive, wildcard-safe), category, price range', async () => {
    expect((await list('?q=SPECIAL&limit=100')).items.every((p) => /special/i.test(p.name))).toBe(
      true,
    );
    expect((await list('?q=SPECIAL&limit=100')).items).toHaveLength(5);
    expect((await list('?q=%25&limit=100')).items).toHaveLength(0);
    expect((await list('?q=_&limit=100')).items).toHaveLength(0);
    expect((await list("?q='%20OR%201=1--&limit=100")).items).toHaveLength(0);
    const alpha = await list('?category=alpha&limit=100');
    expect(alpha.items.length).toBe(15);
    expect(alpha.items.every((p) => p.categorySlug === 'alpha')).toBe(true);
    const ranged = await list('?minPrice=1500&maxPrice=2000&limit=100');
    expect(ranged.items.length).toBeGreaterThan(0);
    expect(ranged.items.every((p) => p.price >= 1500 && p.price <= 2000)).toBe(true);
    expect((await list('?category=nope')).items).toHaveLength(0);
  });

  it('sorting works in every direction', async () => {
    const asc = (await list('?sort=price_asc&limit=100')).items.map((p) => p.price);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    const desc = (await list('?sort=price_desc&limit=100')).items.map((p) => p.price);
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    const names = (await list('?sort=name&limit=100')).items.map((p) => p.name);
    expect(names).toEqual([...names].sort());
    const newest = (await list('?sort=newest&limit=100')).items.map((p) => p.createdAt);
    expect(newest).toEqual([...newest].sort().reverse());
  });

  it('cursor pagination visits every product exactly once for every sort order, even with equal prices', async () => {
    for (const sort of ['newest', 'price_asc', 'price_desc', 'name']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const r = await list(`?sort=${sort}&limit=7${cursor ? `&cursor=${cursor}` : ''}`);
        seen.push(...r.items.map((p) => p.id));
        cursor = r.nextCursor;
        pages++;
      } while (cursor && pages < 20);
      expect(new Set(seen).size, sort).toBe(30);
      expect(seen.length, sort).toBe(30);
      expect(pages, sort).toBe(5);
    }
  });

  it('pagination stays stable while products are inserted and removed between pages', async () => {
    const first = await list('?sort=price_asc&limit=10');
    await makeProduct(app, { name: 'Inserted during paging', price: 1 });
    const second = await list(`?sort=price_asc&limit=10&cursor=${first.nextCursor}`);
    const ids = new Set(first.items.map((p) => p.id));
    expect(second.items.every((p) => !ids.has(p.id))).toBe(true);
  });

  it('rejects bad queries with 400 and tampered cursors with 400, never 500', async () => {
    for (const qs of [
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?minPrice=-1',
      '?minPrice=5&maxPrice=1',
      '?sort=hack',
      '?cursor=%%%',
      '?cursor=e30',
      `?cursor=${Buffer.from('{"id":"x"}').toString('base64url')}`,
      `?sort=price_asc&cursor=${Buffer.from('{"p":"1; DROP","id":"00000000-0000-4000-8000-000000000000"}').toString('base64url')}`,
      '?q=' + 'a'.repeat(101),
    ]) {
      const r = await anon(app).get(`/products${qs}`);
      expect(r.status, qs).toBe(400);
      expect(r.body.error.code).toBe('validation_error');
    }
  });

  it('single product: found, 404 for unknown / malformed id, inactive hidden from customers', async () => {
    const p = await makeProduct(app, { name: 'Single' });
    expect((await anon(app).get(`/products/${p.id}`)).status).toBe(200);
    expect((await anon(app).get('/products/00000000-0000-4000-8000-000000000000')).status).toBe(
      404,
    );
    expect((await anon(app).get('/products/not-a-uuid')).status).toBe(400);
    const hidden = await makeProduct(app, { active: false });
    expect((await customer.get(`/products/${hidden.id}`)).status).toBe(404);
    expect((await manager.get(`/products/${hidden.id}`)).status).toBe(200);
  });
});

describe('product management (manager only)', () => {
  it('manager creates, edits stock/price, and "deletes" (hides) a product', async () => {
    const [cat] = await app.tdb.db
      .insert(schema.categories)
      .values({ name: 'Mgmt', slug: 'mgmt' })
      .returning();
    const created = await manager.post('/products', {
      name: 'New gadget',
      categoryId: cat!.id,
      price: 4999,
      stock: 12,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'New gadget',
      price: 4999,
      stock: 12,
      active: true,
      categoryName: 'Mgmt',
    });
    const id = created.body.id as string;
    const upd = await manager.patch(`/products/${id}`, { stock: 3, price: 5999 });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ stock: 3, price: 5999 });
    expect((await manager.del(`/products/${id}`)).status).toBe(204);
    expect((await anon(app).get(`/products/${id}`)).status).toBe(404);
    expect((await manager.get(`/products/${id}`)).body.active).toBe(false);
  });

  it('customers and anonymous users are refused on every write (direct requests)', async () => {
    const p = await makeProduct(app);
    const body = { name: 'Hack', categoryId: p.categoryId, price: 1, stock: 1_000_000 };
    for (const c of [customer, anon(app)]) {
      const expected = c === customer ? 403 : 401;
      expect((await c.post('/products', body)).status).toBe(expected);
      expect((await c.patch(`/products/${p.id}`, { price: 1 })).status).toBe(expected);
      expect((await c.del(`/products/${p.id}`)).status).toBe(expected);
    }
    expect((await anon(app).get(`/products/${p.id}`)).body.price).toBe(p.price); // untouched
  });

  it('validates input: negative stock/price, unknown category, empty patch, extra fields ignored', async () => {
    const p = await makeProduct(app);
    const bad: unknown[] = [
      { name: 'x', categoryId: p.categoryId, price: 100, stock: 1 },
      { name: 'Valid name', categoryId: p.categoryId, price: 0, stock: 1 },
      { name: 'Valid name', categoryId: p.categoryId, price: -5, stock: 1 },
      { name: 'Valid name', categoryId: p.categoryId, price: 1.5, stock: 1 },
      { name: 'Valid name', categoryId: p.categoryId, price: 100, stock: -1 },
      { name: 'Valid name', categoryId: 'nope', price: 100, stock: 1 },
      { name: 'Valid name', categoryId: p.categoryId, price: 100, stock: 1e12 },
      { name: 'Valid name', categoryId: p.categoryId, price: '100', stock: 1 },
    ];
    for (const b of bad)
      expect((await manager.post('/products', b)).status, JSON.stringify(b)).toBe(400);
    expect(
      (
        await manager.post('/products', {
          name: 'Valid name',
          categoryId: '00000000-0000-4000-8000-000000000000',
          price: 100,
          stock: 1,
        })
      ).status,
    ).toBe(422);
    expect((await manager.patch(`/products/${p.id}`, {})).status).toBe(400);
    expect((await manager.patch(`/products/${p.id}`, { stock: -3 })).status).toBe(400);
    expect(
      (await manager.patch('/products/00000000-0000-4000-8000-000000000000', { stock: 3 })).status,
    ).toBe(404);
    const ok = await manager.post('/products', {
      name: 'Valid name',
      categoryId: p.categoryId,
      price: 100,
      stock: 1,
      id: '00000000-0000-4000-8000-000000000000',
      createdAt: '2000-01-01',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.id).not.toBe('00000000-0000-4000-8000-000000000000'); // mass assignment ignored
  });
});

describe('regressions found by the tests', () => {
  it('PATCHing a hidden product must not silently re-activate it', async () => {
    const hidden = await makeProduct(app, { active: false, price: 1000 });
    const r = await manager.patch(`/products/${hidden.id}`, { price: 1200 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ price: 1200, active: false });
    expect((await anon(app).get(`/products/${hidden.id}`)).status).toBe(404);
  });
});
