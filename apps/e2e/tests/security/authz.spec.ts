import { expect, request as pwRequest, test } from '@playwright/test';
import {
  api,
  BASE,
  createProduct,
  customer,
  getOrder,
  MANAGER,
  managerApi,
  paidOrder,
  tag,
  uuid,
  visitor,
} from '../helpers';

const A = customer(30);
const B = customer(31);

test.describe('who may call what', () => {
  test('a visitor gets 401 from every protected endpoint (and never a 5xx)', async () => {
    const v = await visitor();
    const id = uuid();
    const calls: [string, string][] = [
      ['GET', '/api/me'],
      ['GET', '/api/cart'],
      ['PUT', `/api/cart/items/${id}`],
      ['DELETE', `/api/cart/items/${id}`],
      ['POST', '/api/cart/promo'],
      ['POST', '/api/cart/accept-prices'],
      ['GET', '/api/orders'],
      ['POST', '/api/orders'],
      ['GET', `/api/orders/${id}`],
      ['POST', `/api/orders/${id}/cancel`],
      ['POST', `/api/orders/${id}/pay`],
      ['POST', `/api/orders/${id}/returns`],
      ['PATCH', `/api/orders/${id}/status`],
      ['GET', '/api/promos'],
      ['POST', '/api/promos'],
      ['POST', '/api/products'],
      ['PATCH', `/api/products/${id}`],
      ['DELETE', `/api/products/${id}`],
      ['GET', '/api/reports/sales?from=2026-01-01&to=2026-01-02'],
    ];
    for (const [method, url] of calls) {
      const r = await v.fetch(url, { method, data: method === 'GET' ? undefined : {} });
      expect(r.status(), `${method} ${url}`).toBe(401);
    }
    await v.dispose();
  });

  test('a customer gets 403 from every manager endpoint', async () => {
    const c = await api(A);
    const id = uuid();
    const calls: [string, string][] = [
      ['GET', '/api/promos'],
      ['POST', '/api/promos'],
      ['PATCH', `/api/promos/${id}`],
      ['DELETE', `/api/promos/${id}`],
      ['POST', '/api/products'],
      ['PATCH', `/api/products/${id}`],
      ['DELETE', `/api/products/${id}`],
      ['PATCH', `/api/orders/${id}/status`],
      ['GET', '/api/reports/sales?from=2026-01-01&to=2026-01-02'],
    ];
    for (const [method, url] of calls) {
      const r = await c.fetch(url, { method, data: method === 'GET' ? undefined : {} });
      expect(r.status(), `${method} ${url}`).toBe(403);
    }
  });

  test('the manager gets 403 from the customer endpoints (no cart, no orders of their own)', async () => {
    const m = await api(MANAGER);
    const id = uuid();
    const calls: [string, string][] = [
      ['GET', '/api/cart'],
      ['PUT', `/api/cart/items/${id}`],
      ['POST', '/api/cart/promo'],
      ['POST', '/api/orders'],
      ['POST', `/api/orders/${id}/cancel`],
      ['POST', `/api/orders/${id}/pay`],
      ['POST', `/api/orders/${id}/returns`],
    ];
    for (const [method, url] of calls) {
      const r = await m.fetch(url, { method, data: {} });
      expect(r.status(), `${method} ${url}`).toBe(403);
    }
  });

  test('the catalogue is public but hidden products are not: a visitor and a customer cannot see them', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-hidden'), price: 1000 });
    await mgr.patch(`/api/products/${p.id}`, { data: { active: false } });
    const v = await visitor();
    expect((await v.get(`/api/products/${p.id}`)).status()).toBe(404);
    const list = await (await v.get(`/api/products?q=${encodeURIComponent(p.name)}`)).json();
    expect(list.items).toHaveLength(0);
    // includeInactive is a manager feature: the flag from a visitor/customer is ignored, not honoured
    const sneaky = await (
      await v.get(`/api/products?includeInactive=true&q=${encodeURIComponent(p.name)}`)
    ).json();
    expect(sneaky.items).toHaveLength(0);
    const c = await api(A);
    expect((await c.get(`/api/products/${p.id}`)).status()).toBe(404);
    // ...and a customer cannot buy it by guessing its id
    expect(
      (await c.put(`/api/cart/items/${p.id}`, { data: { qty: 1 } })).status(),
    ).toBeGreaterThanOrEqual(400);
    // the manager still sees it
    expect((await mgr.get(`/api/products/${p.id}`)).status()).toBe(200);
  });
});

test.describe("one customer against another customer's data (IDOR)", () => {
  test("B cannot read, cancel, pay or return A's order; A's data does not leak in the error", async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-idor'), price: 5000 });
    const order = await paidOrder(A, [{ productId: p.id, qty: 2 }]);
    const b = await api(B);

    const attempts: [string, string, unknown][] = [
      ['GET', `/api/orders/${order.id}`, undefined],
      ['POST', `/api/orders/${order.id}/cancel`, {}],
      ['POST', `/api/orders/${order.id}/pay`, {}],
      [
        'POST',
        `/api/orders/${order.id}/returns`,
        { items: [{ orderItemId: order.items[0]!.id, qty: 1 }] },
      ],
    ];
    for (const [method, url, data] of attempts) {
      const r = await b.fetch(url, { method, data });
      expect(r.status(), `${method} ${url}`).toBe(404); // not 403: do not even confirm the order exists
      const text = await r.text();
      expect(text).not.toContain(A.email);
      expect(text).not.toContain(order.number);
    }
    // nothing changed
    expect((await getOrder(A, order.id)).status).toBe('paid');

    // B's own list never contains A's order
    const mine = await (await b.get('/api/orders?limit=50')).json();
    expect(mine.items.some((o: { id: string }) => o.id === order.id)).toBe(false);
    // ...even when asking for "everybody's" orders with the manager-only e-mail search
    const probe = await (await b.get(`/api/orders?q=${encodeURIComponent(A.email)}`)).json();
    expect(probe.items.some((o: { id: string }) => o.id === order.id)).toBe(false);
    for (const o of probe.items) expect(o.customerEmail ?? B.email).toBe(B.email);
  });

  test("B cannot see or use A's cart through any identifier in the request", async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-cart'), price: 700 });
    const a = await api(A);
    await a.put(`/api/cart/items/${p.id}`, { data: { qty: 3 } });
    const b = await api(B);
    const cart = await (await b.get('/api/cart?userId=' + uuid())).json();
    expect(cart.lines.some((l: { productId: string }) => l.productId === p.id)).toBe(false);
    // clean up
    await a.delete(`/api/cart/items/${p.id}`);
  });
});

test.describe('sessions', () => {
  test('garbage, truncated and forged session cookies are 401, never a 500', async () => {
    const real = await (await api(A)).storageState();
    const sid = real.cookies.find((c) => c.name === 'sid')!.value;
    const forged = [
      'x',
      '',
      sid.slice(0, -1),
      sid + 'a',
      sid.toUpperCase(),
      sid.split('').reverse().join(''),
      '../../etc/passwd',
      "' OR '1'='1",
      '\u0000',
      'a'.repeat(5000),
    ];
    for (const value of forged) {
      const ctx = await pwRequest.newContext({
        baseURL: BASE,
        extraHTTPHeaders: {
          Origin: BASE,
          Cookie: `sid=${value
            .replace(/[\r\n]/g, '')
            .split('\u0000')
            .join('')}`,
        },
      });
      const r = await ctx.get('/api/me');
      expect(r.status(), `cookie ${value.slice(0, 20)}`).toBe(401);
      await ctx.dispose();
    }
  });

  test('logout kills the session on the SERVER: the old cookie stops working', async () => {
    const who = customer(32);
    const ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
    expect((await ctx.post('/api/auth/login', { data: who })).status()).toBe(200);
    const sid = (await ctx.storageState()).cookies.find((c) => c.name === 'sid')!.value;
    expect((await ctx.get('/api/me')).status()).toBe(200);
    expect((await ctx.post('/api/auth/logout', { data: {} })).status()).toBeLessThan(300);
    expect((await ctx.get('/api/me')).status()).toBe(401);
    // replay the captured cookie by hand (what a thief with an old cookie would do)
    const thief = await pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Origin: BASE, Cookie: `sid=${sid}` },
    });
    expect((await thief.get('/api/me')).status()).toBe(401);
    expect((await thief.get('/api/cart')).status()).toBe(401);
    await thief.dispose();
    await ctx.dispose();
  });

  test('two logins are two independent sessions: logging out of one keeps the other', async () => {
    const who = customer(33);
    const one = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
    const two = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
    await one.post('/api/auth/login', { data: who });
    await two.post('/api/auth/login', { data: who });
    await one.post('/api/auth/logout', { data: {} });
    expect((await one.get('/api/me')).status()).toBe(401);
    expect((await two.get('/api/me')).status()).toBe(200);
    await one.dispose();
    await two.dispose();
  });

  test('the session cookie is HttpOnly + SameSite and a login response never contains the password hash', async () => {
    const ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
    const r = await ctx.post('/api/auth/login', { data: customer(34) });
    const body = await r.text();
    expect(body).not.toMatch(/scrypt|hash|password/i);
    const setCookie = r.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]!.value).toMatch(/HttpOnly/i);
    expect(setCookie[0]!.value).toMatch(/SameSite=Lax/i);
    expect(setCookie[0]!.value).toMatch(/Path=\//i);
    await ctx.dispose();
  });

  test('login does not reveal whether an e-mail exists (same status, same body, similar time)', async () => {
    const v = await visitor();
    const time = async (email: string) => {
      const t = Date.now();
      const r = await v.post('/api/auth/login', { data: { email, password: 'Wrong-Password-1' } });
      return { status: r.status(), body: await r.json(), ms: Date.now() - t };
    };
    const known = await time(customer(35).email);
    const unknown = await time(`nobody-${Date.now()}@shop.test`);
    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(known.body.error.message).toBe(unknown.body.error.message);
    expect(known.body.error.code).toBe(unknown.body.error.code);
    // not a precise timing test (noisy), but a missing-user fast path would be an order of magnitude faster
    expect(unknown.ms).toBeGreaterThan(known.ms / 8);
    await v.dispose();
  });
});

test.describe('CSRF and cross-origin', () => {
  test('state-changing requests from a foreign or "null" origin are refused, even with a valid cookie', async () => {
    const sid = (await (await api(A)).storageState()).cookies.find((c) => c.name === 'sid')!.value;
    for (const origin of [
      'https://evil.example',
      'null',
      `${BASE}.evil.example`,
      'http://localhost:3000',
    ]) {
      const ctx = await pwRequest.newContext({
        baseURL: BASE,
        extraHTTPHeaders: { Origin: origin, Cookie: `sid=${sid}` },
      });
      const r = await ctx.post('/api/orders/' + uuid() + '/cancel', { data: {} });
      expect(r.status(), `Origin: ${origin}`).toBe(403);
      const login = await ctx.post('/api/auth/logout', { data: {} });
      expect(login.status(), `logout from ${origin}`).toBe(403);
      await ctx.dispose();
    }
    // still logged in: the forged logout did not work
    expect((await (await api(A)).get('/api/me')).status()).toBe(200);
  });

  test('a "simple" cross-site form post (text/plain, urlencoded, multipart) cannot do anything either', async () => {
    const sid = (await (await api(A)).storageState()).cookies.find((c) => c.name === 'sid')!.value;
    const ctx = await pwRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Origin: 'https://evil.example', Cookie: `sid=${sid}` },
    });
    for (const [type, body] of [
      ['text/plain', '{"deliveryMethod":"pickup"}'],
      ['application/x-www-form-urlencoded', 'deliveryMethod=pickup'],
      [
        'multipart/form-data; boundary=x',
        '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--',
      ],
    ] as const) {
      const r = await ctx.post('/api/orders', {
        headers: { 'content-type': type, 'idempotency-key': uuid() },
        data: Buffer.from(body),
      });
      expect(r.status(), type).toBe(403);
    }
    await ctx.dispose();
  });

  test('no CORS: a preflight from another site gets no permission headers', async () => {
    const v = await pwRequest.newContext({ baseURL: BASE });
    const r = await v.fetch('/api/orders', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const h = r.headers();
    expect(h['access-control-allow-origin']).toBeUndefined();
    expect(h['access-control-allow-credentials']).toBeUndefined();
    const get = await v.get('/api/products?limit=1', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(get.headers()['access-control-allow-origin']).toBeUndefined();
    await v.dispose();
  });

  test('a customer cannot escalate: role, status and ownership fields in bodies are ignored', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-mass'), price: 1500 });
    const c = await api(A);
    await c.put(`/api/cart/items/${p.id}`, { data: { qty: 1 } });
    const r = await c.post('/api/orders', {
      headers: { 'Idempotency-Key': uuid() },
      data: {
        deliveryMethod: 'pickup',
        // none of these may be honoured:
        status: 'paid',
        total: 1,
        subtotal: 1,
        userId: uuid(),
        role: 'manager',
        paidAt: new Date().toISOString(),
        __proto__: { role: 'manager' },
        constructor: { prototype: { role: 'manager' } },
      },
    });
    expect([200, 201, 400, 422]).toContain(r.status());
    if (r.status() < 300) {
      const o = await r.json();
      expect(o.status).toBe('awaiting_payment');
      expect(o.total).toBe(1500);
    }
    // and the session was not upgraded
    expect((await (await c.get('/api/me')).json()).role).toBe('customer');
    expect((await c.get('/api/promos')).status()).toBe(403);
  });
});
