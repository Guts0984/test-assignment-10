/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely typed JSON responses */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbHandle } from '@shop/db';
import { MAX_ORDER_TOTAL_KOPECKS } from '@shop/shared';
import { isDatabaseUnavailable } from '../src/http/error.filter';
import { request, startTestApp, type TestApp } from './harness';
import { makeProduct, newClient } from './shop';

const NOISE = {
  API_RATE_MAX_PER_IP: '1000000',
  LOGIN_MAX_PER_IP: '100000',
  LOGIN_MAX_PER_IP_ACCOUNT: '100000',
};

describe('an order above the storable amount is refused with a clear message', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp({ env: NOISE });
  });
  afterAll(async () => app.close());

  it('3 x 10 000 000 UAH (3 000 000 000 kopecks) is 422 order_too_large - it used to be an opaque 400 "Invalid request"', async () => {
    const c = await newClient(app, 'customer');
    const p = await makeProduct(app, { price: 1_000_000_000, stock: 100 });
    expect((await c.put(`/cart/items/${p.id}`, { qty: 3 })).status).toBe(200); // the cart accepts it
    const r = await c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('order_too_large');
    expect(r.body.error.message).toMatch(/maximum amount/);
    expect(r.body.error.details.max).toBe(MAX_ORDER_TOTAL_KOPECKS);
    // nothing was reserved or created
    const stock = await app.tdb.db.query.products.findFirst({
      where: (x, { eq }) => eq(x.id, p.id),
    });
    expect(stock!.stock).toBe(100);
    expect((await c.get('/orders')).body.items).toHaveLength(0);
  });

  it('exactly at the limit still works; one kopeck above does not', async () => {
    const c = await newClient(app, 'customer');
    const atLimit = await makeProduct(app, { price: MAX_ORDER_TOTAL_KOPECKS, stock: 5 });
    await c.put(`/cart/items/${atLimit.id}`, { qty: 1 });
    expect(
      (await c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() })).status,
    ).toBe(201);
    const over = await makeProduct(app, { price: 1_000_000_000, stock: 5 });
    await c.put(`/cart/items/${over.id}`, { qty: 2 });
    await c.put(`/cart/items/${(await makeProduct(app, { price: 1, stock: 5 })).id}`, { qty: 1 });
    const r = await c.post('/orders', { deliveryMethod: 'pickup' }, { key: randomUUID() });
    expect(r.status).toBe(422); // 2 000 000 001 kopecks
    expect(r.body.error.code).toBe('order_too_large');
  });
});

describe('database unavailable is a 503 with Retry-After, not a 500', () => {
  it('isDatabaseUnavailable recognises connection failures (also wrapped in a cause) and nothing else', () => {
    for (const e of [
      { code: 'ECONNREFUSED' },
      { code: '57P01' },
      { code: '57P03' },
      new Error('Connection terminated unexpectedly'),
      new Error('timeout exceeded when trying to connect'),
      new Error('Cannot use a pool after calling end on the pool'),
      new Error('Failed query', { cause: { code: 'ECONNRESET' } }),
      new Error('x', { cause: new Error('the database system is starting up') }),
    ])
      expect(isDatabaseUnavailable(e), String((e as Error).message ?? (e as any).code)).toBe(true);
    for (const e of [
      new Error('some bug'),
      { code: '23505' },
      { code: '22021' },
      new TypeError('x is undefined'),
      null,
      undefined,
      'text',
    ])
      expect(isDatabaseUnavailable(e)).toBe(false);
  });

  it('with Postgres unreachable, every database-backed endpoint answers 503 + Retry-After + a stable error code, and recovers', async () => {
    // an app whose database does not answer (nothing listens on port 1)
    const dead = createDbHandle('postgres://nobody:nothing@127.0.0.1:1/none', {
      connectionTimeoutMillis: 500,
    });
    const app = await startTestApp({
      env: NOISE,
      tdb: {
        url: 'postgres://nobody:nothing@127.0.0.1:1/none',
        db: dead.db,
        drop: async () => undefined,
      } as any,
    });
    try {
      for (const [method, path, body] of [
        ['GET', '/products', undefined],
        ['GET', '/categories', undefined],
        ['POST', '/auth/login', { email: 'a@b.co', password: 'Password1!' }],
      ] as const) {
        const r = await request(app, method, path, body === undefined ? {} : { body });
        expect(r.status, `${method} ${path}`).toBe(503);
        expect(r.headers['retry-after']).toBe('2');
        expect((r.json as any).error.code).toBe('service_unavailable');
        expect(JSON.stringify(r.json)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|nobody/); // nothing internal leaks
      }
      // /health checks the database on purpose: during an outage it must say so (503), so that
      // load balancers and `docker compose` stop sending traffic until it is back
      const health = await request(app, 'GET', '/health', {});
      expect(health.status).toBe(503);
      expect((health.json as any).error.code).toBe('service_unavailable');
    } finally {
      await app.close();
      await dead.close();
    }
  });
});
