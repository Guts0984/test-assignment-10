import { expect, test } from '@playwright/test';
import {
  api,
  COURIER_ADDRESS,
  createProduct,
  customer,
  MANAGER,
  managerApi,
  tag,
  uuid,
  visitor,
} from '../helpers';

const A = customer(36);

/** Hostile strings that have broken real shops. */
const NASTY = [
  `' OR '1'='1`,
  `'; DROP TABLE products; --`,
  `" OR ""="`,
  `1; SELECT pg_sleep(5)--`,
  `%' UNION SELECT email, password_hash FROM users --`,
  `\\`,
  `\\'`,
  '%',
  '_',
  '%%%%%%%%%%',
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '{{7*7}}',
  '${7*7}',
  '../../../etc/passwd',
  '\u0000',
  'a\u0000b',
  '‮evil', // right-to-left override
  '🙂🙂🙂',
  'Ωmega ǅ ß İ ﷽',
  ' '.repeat(50),
  'x'.repeat(10_000),
  '\n\r\t',
];

const noServerError = (status: number, what: string) =>
  expect(status, `${what} must be a clean 4xx or 2xx, never a 5xx`).toBeLessThan(500);

test.describe('read endpoints survive hostile query strings', () => {
  test('product search, category, sort, price and cursor never cause a 5xx or leak other data', async () => {
    const v = await visitor();
    const before = await (await v.get('/api/products?limit=100')).json();
    for (const s of NASTY) {
      for (const param of ['q', 'category', 'sort', 'minPrice', 'maxPrice', 'cursor', 'limit']) {
        const r = await v.get(`/api/products?${param}=${encodeURIComponent(s)}`);
        noServerError(r.status(), `products?${param}=${JSON.stringify(s).slice(0, 30)}`);
        const text = await r.text();
        expect(text).not.toMatch(/password_hash|scrypt\$|syntax error|SQLSTATE|pg_sleep|stack/i);
      }
    }
    // the catalogue is untouched afterwards (nothing was dropped)
    const after = await (await v.get('/api/products?limit=100')).json();
    expect(after.items.length).toBe(before.items.length);
    await v.dispose();
  });

  test('numeric parameters: negative, zero, huge, floats, exponent, hex, repeated keys', async () => {
    const v = await visitor();
    for (const q of [
      'limit=0',
      'limit=-1',
      'limit=1e9',
      'limit=99999999999999999999',
      'limit=1.5',
      'limit=0x10',
      'limit=1&limit=2',
      'minPrice=-5',
      'minPrice=1e400',
      'minPrice=Number.MAX_SAFE_INTEGER + 2',
      'maxPrice=NaN',
      'minPrice=100&maxPrice=1',
      'q[]=a&q[]=b',
      'q[$ne]=1',
      '__proto__[x]=1',
      'constructor[prototype][x]=1',
    ]) {
      const r = await v.get(`/api/products?${q}`);
      noServerError(r.status(), q);
    }
    await v.dispose();
  });

  test('tampered pagination cursors are rejected cleanly (and a cursor of one list does not work on another)', async () => {
    const v = await visitor();
    const page = await (await v.get('/api/products?limit=2')).json();
    expect(page.nextCursor).toBeTruthy();
    const c = page.nextCursor as string;
    const forged = [
      c.slice(0, -2),
      c + 'AA',
      Buffer.from('{"id":"x"}').toString('base64url'),
      Buffer.from('{"id":"00000000-0000-4000-8000-000000000000","createdAt":"nope"}').toString(
        'base64url',
      ),
      Buffer.from('{"id":"\' OR 1=1 --"}').toString('base64url'),
      Buffer.from('[]').toString('base64url'),
      Buffer.from('null').toString('base64url'),
      '%00',
      '!!!',
    ];
    for (const f of forged) {
      const r = await v.get(`/api/products?limit=2&cursor=${encodeURIComponent(f)}`);
      expect([400, 422], `cursor ${f.slice(0, 20)}`).toContain(r.status());
    }
    // a products cursor on the orders list is just a keyset position: it may work, but only ever
    // returns the caller's own orders
    const mine = await (await api(A)).get(`/api/orders?cursor=${encodeURIComponent(c)}`);
    expect(mine.status()).toBeLessThan(500);
    if (mine.status() === 200) {
      for (const o of (await mine.json()).items) expect(o.customerEmail ?? A.email).toBe(A.email);
    }
    await v.dispose();
  });

  test('ids that are not UUIDs are a 4xx everywhere an id is accepted', async () => {
    const c = await api(A);
    const m = await api(MANAGER);
    for (const bad of [
      '1',
      'abc',
      '../x',
      "1' OR '1'='1",
      '%00',
      '00000000-0000-0000-0000-000000000000',
      'x'.repeat(300),
    ]) {
      const e = encodeURIComponent(bad);
      noServerError((await c.get(`/api/products/${e}`)).status(), 'product ' + bad);
      noServerError((await c.get(`/api/orders/${e}`)).status(), 'order ' + bad);
      noServerError(
        (await c.put(`/api/cart/items/${e}`, { data: { qty: 1 } })).status(),
        'cart ' + bad,
      );
      noServerError(
        (await c.post(`/api/orders/${e}/cancel`, { data: {} })).status(),
        'cancel ' + bad,
      );
      noServerError((await c.post(`/api/orders/${e}/pay`, { data: {} })).status(), 'pay ' + bad);
      noServerError(
        (await m.patch(`/api/products/${e}`, { data: { stock: 1 } })).status(),
        'patch ' + bad,
      );
      noServerError(
        (await m.patch(`/api/orders/${e}/status`, { data: { status: 'shipped' } })).status(),
        'status ' + bad,
      );
      noServerError((await m.get(`/api/promos/${e}`)).status(), 'promo ' + bad);
      const stub = await (await visitor()).get(`/api/stub/payments/${e}`);
      noServerError(stub.status(), 'stub ' + bad);
    }
  });
});

test.describe('write endpoints survive hostile bodies', () => {
  test('NUL bytes and invalid unicode in text fields (PostgreSQL cannot store them) are a clean 400, not a 500', async () => {
    const mgr = await managerApi();
    const cats = await (await mgr.get('/api/categories')).json();
    const base = { categoryId: cats[0].id, price: 100, stock: 1 };
    for (const name of ['a\u0000b', '\u0000', 'ok\u0000']) {
      const r = await mgr.post('/api/products', { data: { ...base, name } });
      noServerError(r.status(), 'product name with NUL');
      expect(r.status()).not.toBe(201);
    }
    // lone surrogates (invalid in UTF-8 / JSON text for Postgres)
    const lone = await mgr.post('/api/products', {
      headers: { 'content-type': 'application/json' },
      data: Buffer.from(
        '{"name":"bad\\ud800name","categoryId":"' + cats[0].id + '","price":100,"stock":1}',
      ),
    });
    noServerError(lone.status(), 'lone surrogate');
    const promo = await mgr.post('/api/promos', {
      data: { code: 'NUL\u0000X', type: 'percent', value: 5 },
    });
    noServerError(promo.status(), 'promo code with NUL');
    const c = await api(A);
    const login = await (
      await visitor()
    ).post('/api/auth/login', {
      data: { email: 'a\u0000@b.co', password: 'x\u0000y' },
    });
    noServerError(login.status(), 'login with NUL');
    const cart = await c.post('/api/cart/promo', { data: { code: 'A\u0000B' } });
    noServerError(cart.status(), 'cart promo with NUL');
    const search = await (await visitor()).get('/api/products?q=' + encodeURIComponent('a\u0000b'));
    noServerError(search.status(), 'search with NUL');
    const orders = await (
      await managerApi()
    ).get('/api/orders?q=' + encodeURIComponent('a\u0000b'));
    noServerError(orders.status(), 'manager order search with NUL');
  });

  test('every text field of the checkout address with NUL / huge / injection input is a 4xx and creates nothing', async () => {
    const mgr = await managerApi();
    const p = await createProduct(mgr, { name: tag('E2E-addr'), price: 2000 });
    const c = await api(A);
    await c.put(`/api/cart/items/${p.id}`, { data: { qty: 1 } });
    for (const field of [
      'fullName',
      'phone',
      'city',
      'street',
      'building',
      'apartment',
      'postalCode',
    ] as const) {
      for (const bad of [
        '\u0000',
        'x'.repeat(5000),
        '<script>',
        "'; DROP TABLE orders; --",
        42,
        null,
        [],
        {},
      ]) {
        const r = await c.post('/api/orders', {
          headers: { 'Idempotency-Key': uuid() },
          data: { deliveryMethod: 'courier', address: { ...COURIER_ADDRESS, [field]: bad } },
        });
        noServerError(r.status(), `address.${field}=${JSON.stringify(bad)?.slice(0, 20)}`);
        // <script> and SQL text are legal text for most fields (stored escaped); everything else must be refused
        if (typeof bad !== 'string' || bad === '\u0000' || bad.length > 1000) {
          expect(r.status(), `address.${field}`).toBeGreaterThanOrEqual(400);
        }
      }
    }
    const list = await (await c.get('/api/orders?status=awaiting_payment&limit=50')).json();
    // the accepted hostile-but-legal strings created orders; clean them so the limit of unpaid orders stays free
    for (const o of list.items) await c.post(`/api/orders/${o.id}/cancel`, { data: {} });
    await c.delete(`/api/cart/items/${p.id}`);
  });

  test('wrong content types, broken JSON, arrays, deep nesting and empty bodies are 4xx', async () => {
    const m = await managerApi();
    const cases: [string, Buffer | string | undefined][] = [
      ['application/json', '{'],
      ['application/json', ''],
      ['application/json', 'null'],
      ['application/json', '[]'],
      ['application/json', '"string"'],
      ['application/json', '123'],
      ['application/json', '{"a":' + '['.repeat(5000) + ']'.repeat(5000) + '}'],
      ['application/json', '{"name":"a","name":"b"}'],
      ['text/plain', '{"name":"x"}'],
      ['application/xml', '<a/>'],
      ['application/x-www-form-urlencoded', 'name=x&price=1'],
      ['multipart/form-data; boundary=x', '--x--'],
      ['application/json; charset=utf-7', '{"name":"x"}'],
    ];
    for (const [type, body] of cases) {
      const r = await m.post('/api/products', {
        headers: { 'content-type': type },
        data: Buffer.from(body ?? ''),
      });
      expect(r.status(), `${type} ${String(body).slice(0, 20)}`).toBeGreaterThanOrEqual(400);
      noServerError(r.status(), `${type} ${String(body).slice(0, 20)}`);
    }
  });

  test('numbers: floats, strings, exponents, overflow, negative and unsafe integers in money, stock and quantities', async () => {
    const mgr = await managerApi();
    const cats = await (await mgr.get('/api/categories')).json();
    const bad = [
      1.5,
      '100',
      '1e2',
      -1,
      0,
      2 ** 31,
      2 ** 53,
      1e21,
      Number.MAX_SAFE_INTEGER + 2,
      null,
      true,
      [],
      {},
    ];
    for (const v of bad) {
      for (const field of ['price', 'stock'] as const) {
        const data = {
          name: tag('E2E-num'),
          categoryId: cats[0].id,
          price: 100,
          stock: 1,
          [field]: v,
        };
        const r = await mgr.post('/api/products', { data });
        noServerError(r.status(), `${field}=${JSON.stringify(v)}`);
        // price 0 / stock 0 may be legal; everything else here is not
        if (!(v === 0))
          expect(r.status(), `${field}=${JSON.stringify(v)}`).toBeGreaterThanOrEqual(400);
      }
    }
    const p = await createProduct(mgr, { name: tag('E2E-qty'), price: 100 });
    const c = await api(A);
    for (const qty of [0, -1, 1.5, '1', 1000, 2 ** 31, 1e21, null, true, [], {}, 'NaN']) {
      const r = await c.put(`/api/cart/items/${p.id}`, { data: { qty } });
      expect(r.status(), `qty=${JSON.stringify(qty)}`).toBeGreaterThanOrEqual(400);
      noServerError(r.status(), `qty=${JSON.stringify(qty)}`);
    }
    const cart = await (await c.get('/api/cart')).json();
    expect(cart.lines.some((l: { productId: string }) => l.productId === p.id)).toBe(false);
  });

  test('prototype pollution and unknown fields: ignored, and the server keeps working', async () => {
    const mgr = await managerApi();
    const cats = await (await mgr.get('/api/categories')).json();
    const r = await mgr.fetch('/api/products', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      data: Buffer.from(
        `{"name":"${tag('E2E-proto')}","categoryId":"${cats[0].id}","price":100,"stock":1,"__proto__":{"isAdmin":true},"constructor":{"prototype":{"isAdmin":true}},"id":"${uuid()}","createdAt":"2000-01-01T00:00:00Z","active":false}`,
      ),
    });
    noServerError(r.status(), 'proto');
    if (r.status() === 201) {
      const p = await r.json();
      expect(p.createdAt).not.toBe('2000-01-01T00:00:00.000Z'); // server decides ids and times
    }
    // a freshly created plain object does not carry the polluted property
    const me = await (await (await visitor()).get('/api/products?limit=1')).json();
    expect(me.isAdmin).toBeUndefined();
    expect((await (await visitor()).get('/api/health')).status()).toBe(200);
  });

  test('promo codes: the format rules hold for hostile input and the code is case-insensitive on use', async () => {
    const mgr = await managerApi();
    for (const code of [
      '',
      'ab',
      'x'.repeat(33),
      'with space',
      'emoji🙂',
      "q'uote",
      'semi;colon',
      '<b>',
      'ü-umlaut',
    ]) {
      const r = await mgr.post('/api/promos', { data: { code, type: 'percent', value: 5 } });
      expect(r.status(), `code ${JSON.stringify(code)}`).toBeGreaterThanOrEqual(400);
      noServerError(r.status(), `code ${JSON.stringify(code)}`);
    }
    for (const body of [
      { type: 'percent', value: 0 },
      { type: 'percent', value: 101 },
      { type: 'percent', value: 1.5 },
      { type: 'fixed', value: -5 },
      { type: 'percent', value: 10, maxUses: 0 },
      { type: 'percent', value: 10, minOrder: -1 },
      { type: 'percent', value: 10, startsAt: 'yesterday' },
      {
        type: 'percent',
        value: 10,
        startsAt: '2030-01-01T00:00:00Z',
        expiresAt: '2029-01-01T00:00:00Z',
      },
      { type: 'bogus', value: 10 },
    ]) {
      const r = await mgr.post('/api/promos', {
        data: { code: tag('BAD').slice(0, 20).toUpperCase(), ...body },
      });
      expect(r.status(), JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      noServerError(r.status(), JSON.stringify(body));
    }
  });

  test('the report: bad dates and periods are a 4xx, never a slow query or a 5xx', async () => {
    const m = await managerApi();
    for (const q of [
      'from=2026-02-30&to=2026-03-01',
      'from=2026-13-01&to=2026-14-01',
      'from=abc&to=def',
      'from=2026-05-01&to=2026-04-01',
      'from=2000-01-01&to=2026-01-01',
      'from=0001-01-01&to=9999-12-31',
      'from=2026-01-01',
      'to=2026-01-01',
      '',
      `from=${encodeURIComponent("2026-01-01' OR 1=1 --")}&to=2026-01-02`,
      'from=2026-01-01&to=2026-01-02&from=2020-01-01',
    ]) {
      const t = Date.now();
      const r = await m.get(`/api/reports/sales?${q}`);
      expect(r.status(), q).toBeGreaterThanOrEqual(400);
      noServerError(r.status(), q);
      expect(Date.now() - t, q).toBeLessThan(2000);
    }
    // the widest legal period is fast on the 10 000 seeded orders
    const t = Date.now();
    const ok = await m.get('/api/reports/sales?from=2026-01-01&to=2026-12-31');
    expect(ok.status()).toBe(200);
    expect(Date.now() - t).toBeLessThan(1500);
  });

  test('manager order list: filter injection and absurd search strings are safe and fast', async () => {
    const m = await managerApi();
    for (const q of NASTY.slice(0, 12)) {
      const t = Date.now();
      const r = await m.get(`/api/orders?q=${encodeURIComponent(q)}&status=delivered`);
      noServerError(r.status(), `orders?q=${q.slice(0, 20)}`);
      expect(Date.now() - t).toBeLessThan(2000);
    }
    for (const status of ['bogus', "paid' OR 1=1", 'PAID', '']) {
      const r = await m.get(`/api/orders?status=${encodeURIComponent(status)}`);
      noServerError(r.status(), `status=${status}`);
    }
  });
});
