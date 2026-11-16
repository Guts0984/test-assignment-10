import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, request, startTestApp, type TestApp } from './harness';
import { TestRoutesModule } from './test-routes';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({
    extraModules: [TestRoutesModule],
    env: {
      API_RATE_MAX_PER_IP: '100000',
      LOGIN_MAX_PER_IP: '100000',
      LOGIN_MAX_PER_IP_ACCOUNT: '100000',
      BODY_LIMIT_KB: '100',
    },
  });
});
afterAll(async () => app.close());

type ErrBody = { error: { code: string; message: string; details?: unknown; requestId?: string } };
const err = (r: { json: unknown }) => (r.json as ErrBody).error;

describe('hostile input never produces a 5xx', () => {
  const post = (body: Parameters<typeof request>[3]) => request(app, 'POST', '/auth/login', body);

  it('malformed JSON, wrong content types and non-object bodies are 400-class', async () => {
    const cases: Parameters<typeof request>[3][] = [
      { rawBody: '{"email": "a@b.co", ' },
      { rawBody: '' },
      { rawBody: 'null' },
      { rawBody: '[]' },
      { rawBody: '"string"' },
      { rawBody: '123' },
      { rawBody: '{', headers: { 'Content-Type': 'application/json' } },
      {
        rawBody: 'email=a@b.co&password=x',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
      { rawBody: '<xml/>', headers: { 'Content-Type': 'text/xml' } },
      { rawBody: '{"email":"a@b.co","password":"x"}', headers: { 'Content-Type': 'text/plain' } },
      { rawBody: '\u0000\u0001\u0002' },
      { rawBody: Buffer.from([0xff, 0xfe, 0xfd]) },
      {
        rawBody: '{"email":"a@b.co","password":"x"}',
        headers: { 'Content-Type': 'application/json; charset=utf-16' },
      },
    ];
    for (const c of cases) {
      const r = await post(c);
      expect(r.status, JSON.stringify(c).slice(0, 80)).toBeGreaterThanOrEqual(400);
      expect(r.status, JSON.stringify(c).slice(0, 80)).toBeLessThan(500);
      expect(err(r).code).toBeTruthy();
    }
  });

  it('wrong types and injection payloads in fields are rejected as validation errors', async () => {
    const bodies: unknown[] = [
      { email: { $ne: null }, password: 'x' },
      { email: ['a@b.co'], password: 'x' },
      { email: 'a@b.co', password: { toString: 'x' } },
      { email: 'a@b.co', password: 12345 },
      { email: 'a@b.co' },
      { password: 'x' },
      { email: "admin'--@b.co", password: 'x' },
      { email: 'a@b.co\u0000', password: 'x' },
      { email: `${'a'.repeat(300)}@b.co`, password: 'x' },
      { email: 'a@b.co', password: 'x'.repeat(10_000) },
      { email: 'a@b.co', password: null },
      { email: '', password: '' },
    ];
    for (const body of bodies) {
      const r = await post({ body });
      expect([400, 401], JSON.stringify(body).slice(0, 60)).toContain(r.status);
      if (r.status === 400) expect(err(r).code).toBe('validation_error');
    }
  });

  it('prototype pollution attempts have no effect', async () => {
    await createUser(app.tdb, { email: 'pp@shop.test' });
    const r = await post({
      rawBody:
        '{"email":"pp@shop.test","password":"Password123!","__proto__":{"role":"manager","isAdmin":true},"constructor":{"prototype":{"polluted":true}}}',
    });
    expect(r.status).toBe(200);
    expect((r.json as { role: string }).role).toBe('customer');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
    expect(
      (await request(app, 'POST', '/test/echo', { rawBody: '{"n":1,"__proto__":{"x":1}}' })).status,
    ).toBe(201);
  });

  it('oversized bodies get 413, deeply nested JSON gets 4xx, and the server keeps working', async () => {
    const big = await request(app, 'POST', '/test/echo', {
      rawBody: JSON.stringify({ n: 1, s: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(big.status).toBe(413);
    expect(err(big).code).toBe('payload_too_large');
    const deep = '['.repeat(50_000) + ']'.repeat(50_000);
    const d = await request(app, 'POST', '/test/echo', { rawBody: deep });
    expect(d.status).toBeGreaterThanOrEqual(400);
    expect(d.status).toBeLessThan(500);
    expect((await request(app, 'GET', '/health')).status).toBe(200);
  });

  it('weird URLs and methods are handled: bad percent-encoding, huge paths, unknown routes', async () => {
    for (const path of [
      '/%E0%A4%A',
      '/%00',
      '/me/../../etc/passwd',
      '/' + 'a'.repeat(5000),
      '/docs/%2e%2e/%2e%2e/etc/passwd',
      '/?a[]=1&a[b]=2&__proto__=1',
      '//',
      '/health?x=%ZZ',
    ]) {
      const r = await request(app, 'GET', path);
      expect(r.status, path.slice(0, 40)).toBeLessThan(500);
    }
    for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'PROPFIND']) {
      const r = await request(app, method, '/auth/login', {
        body: { email: 'a@b.co', password: 'x' },
      }).catch(() => null);
      if (r) expect(r.status, method).toBeLessThan(500);
    }
    expect((await request(app, 'GET', '/health')).status).toBe(200);
  });

  it('a slow-loris style half-open body does not take the server down', async () => {
    const net = await import('node:net');
    const sockets = Array.from({ length: 20 }, () => {
      const s = net.connect(app.port, '127.0.0.1');
      s.write(
        'POST /auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"email":',
      );
      return s;
    });
    expect((await request(app, 'GET', '/health')).status).toBe(200);
    sockets.forEach((s) => s.destroy());
  });
});

describe('error format and information leaks', () => {
  it('every error has the same shape and a request id that matches the response header', async () => {
    const r = await request(app, 'GET', '/me');
    expect(r.status).toBe(401);
    expect(err(r)).toMatchObject({ code: 'unauthorized', message: expect.any(String) });
    expect(err(r).requestId).toBe(r.headers['x-request-id']);
    const nf = await request(app, 'GET', '/nope');
    expect(nf.status).toBe(404);
    expect(err(nf).code).toBe('not_found');
    const v = await request(app, 'POST', '/test/echo', { body: { n: -5 } });
    expect(v.status).toBe(400);
    expect(err(v).code).toBe('validation_error');
    expect(Array.isArray(err(v).details)).toBe(true);
    expect(JSON.stringify(err(v).details)).toContain('n');
  });

  it('an unexpected exception is a generic 500 that leaks nothing', async () => {
    await createUser(app.tdb, { email: 'boom@shop.test' });
    const login = await request(app, 'POST', '/auth/login', {
      body: { email: 'boom@shop.test', password: 'Password123!' },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const r = await request(app, 'GET', '/test/boom', { cookie });
    expect(r.status).toBe(500);
    expect(err(r).code).toBe('internal_error');
    expect(r.text).not.toMatch(/hunter2|SECRET|db\.ts|at \w+/);
    expect(r.text).not.toMatch(/stack/i);
  });

  it('sets safe response headers and does not advertise the framework', async () => {
    const r = await request(app, 'GET', '/health');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('does not allow cross-origin reads (no permissive CORS headers)', async () => {
    const r = await request(app, 'GET', '/health', { headers: { Origin: 'https://evil.example' } });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await request(app, 'OPTIONS', '/auth/login', {
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('API docs', () => {
  it('serves Swagger UI on /docs and a JSON document with the documented routes', async () => {
    const ui = await request(app, 'GET', '/docs');
    expect(ui.status).toBe(200);
    const doc = await request(app, 'GET', '/docs-json');
    expect(doc.status).toBe(200);
    const paths = Object.keys((doc.json as { paths: Record<string, unknown> }).paths);
    expect(paths).toEqual(
      expect.arrayContaining(['/auth/login', '/auth/logout', '/me', '/health']),
    );
  });
});
