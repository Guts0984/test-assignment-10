import { eq } from 'drizzle-orm';
import { schema } from '@shop/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, cookieFrom, loginAs, request, startTestApp, type TestApp } from './harness';
import { TestRoutesModule } from './test-routes';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({
    extraModules: [TestRoutesModule],
    env: { API_RATE_MAX_PER_IP: '100000', LOGIN_MAX_PER_IP: '1000' },
  });
});
afterAll(async () => {
  await app.close();
});

describe('login / logout / me', () => {
  it('logs in, sets an httpOnly SameSite cookie, and /me returns the user without secrets', async () => {
    const u = await createUser(app.tdb, { email: 'alice@shop.test' });
    const r = await request(app, 'POST', '/auth/login', {
      body: { email: 'alice@shop.test', password: u.password },
    });
    expect(r.status).toBe(200);
    const setCookie = String(r.headers['set-cookie']);
    expect(setCookie).toMatch(/^sid=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=\d+/);
    expect(setCookie).not.toMatch(/Secure/i); // COOKIE_SECURE=false in tests
    const me = await request(app, 'GET', '/me', { cookie: cookieFrom(r) });
    expect(me.status).toBe(200);
    expect(me.json).toEqual({
      id: u.id,
      email: 'alice@shop.test',
      name: 'Test User',
      role: 'customer',
    });
    expect(me.text).not.toMatch(/password|hash/i);
    expect(r.text).not.toMatch(/password|hash/i);
  });

  it('adds Secure to the cookie when COOKIE_SECURE=true', async () => {
    const secure = await startTestApp({
      tdb: app.tdb,
      env: { COOKIE_SECURE: 'true', API_RATE_MAX_PER_IP: '100000' },
    });
    try {
      const u = await createUser(app.tdb, { email: 'sec@shop.test' });
      const r = await request(secure, 'POST', '/auth/login', {
        body: { email: u.email, password: u.password },
      });
      expect(String(r.headers['set-cookie'])).toMatch(/Secure/);
    } finally {
      await secure.app.close();
    }
  });

  it('normalises e-mail case and whitespace', async () => {
    await createUser(app.tdb, { email: 'bob@shop.test' });
    const r = await request(app, 'POST', '/auth/login', {
      body: { email: '  BoB@Shop.TEST ', password: 'Password123!' },
    });
    expect(r.status).toBe(200);
  });

  it('wrong password and unknown e-mail look identical (no account enumeration)', async () => {
    await createUser(app.tdb, { email: 'carol@shop.test' });
    const a = await request(app, 'POST', '/auth/login', {
      body: { email: 'carol@shop.test', password: 'nope' },
    });
    const b = await request(app, 'POST', '/auth/login', {
      body: { email: 'nobody@shop.test', password: 'nope' },
    });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const strip = (x: Res) =>
      JSON.stringify({ ...(x.json as { error: Record<string, unknown> }).error, requestId: 0 });
    expect(strip(a)).toBe(strip(b));
  });

  it('unknown e-mails cost the same time as wrong passwords (decoy hash)', async () => {
    await createUser(app.tdb, { email: 'dave@shop.test' });
    const time = async (email: string) => {
      const t0 = performance.now();
      await request(app, 'POST', '/auth/login', { body: { email, password: 'wrong' } });
      return performance.now() - t0;
    };
    await time('dave@shop.test'); // warm up
    const known = Math.min(await time('dave@shop.test'), await time('dave@shop.test'));
    const unknown = Math.min(await time('ghost1@shop.test'), await time('ghost2@shop.test'));
    expect(unknown).toBeGreaterThan(known * 0.4);
  });

  it('logout deletes the session on the server: the old cookie stops working', async () => {
    await createUser(app.tdb, { email: 'erin@shop.test' });
    const cookie = await loginAs(app, 'erin@shop.test');
    expect((await request(app, 'GET', '/me', { cookie })).status).toBe(200);
    const out = await request(app, 'POST', '/auth/logout', { cookie });
    expect(out.status).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await request(app, 'GET', '/me', { cookie })).status).toBe(401);
  });

  it('logout without a session is harmless', async () => {
    expect((await request(app, 'POST', '/auth/logout')).status).toBe(204);
  });

  it('each login creates a distinct session; logging out one leaves the other', async () => {
    await createUser(app.tdb, { email: 'frank@shop.test' });
    const c1 = await loginAs(app, 'frank@shop.test');
    const c2 = await loginAs(app, 'frank@shop.test');
    expect(c1).not.toBe(c2);
    await request(app, 'POST', '/auth/logout', { cookie: c1 });
    expect((await request(app, 'GET', '/me', { cookie: c2 })).status).toBe(200);
  });

  it('only a keyed hash of the token is stored, never the token itself', async () => {
    await createUser(app.tdb, { email: 'gina@shop.test' });
    const cookie = await loginAs(app, 'gina@shop.test');
    const token = decodeURIComponent(cookie.split('=')[1]!);
    const rows = await app.tdb.db.select().from(schema.sessions);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.tokenHash === token || r.tokenHash.includes(token))).toBe(false);
  });

  it('sessions expire (fake clock) and expired ones are rejected', async () => {
    await createUser(app.tdb, { email: 'hank@shop.test' });
    const cookie = await loginAs(app, 'hank@shop.test');
    app.clock.advance(app.env.SESSION_TTL_HOURS * 3_600_000 - 1000);
    expect((await request(app, 'GET', '/me', { cookie })).status).toBe(200);
    app.clock.advance(2000);
    expect((await request(app, 'GET', '/me', { cookie })).status).toBe(401);
  });

  it('forged, truncated, wrong-type and injected cookies are all plain 401s', async () => {
    const bad = [
      'sid=',
      'sid=abc',
      `sid=${'A'.repeat(43)}`,
      `sid=${'A'.repeat(5000)}`,
      "sid=' OR 1=1 --",
      'sid=%E0%A4%A',
      'sid[]=x',
      'sid=a; sid=b',
      'other=1',
    ];
    for (const cookie of bad) {
      const r = await request(app, 'GET', '/me', { cookie });
      expect(r.status, cookie).toBe(401);
    }
  });

  it("a deleted user's session stops working immediately", async () => {
    const u = await createUser(app.tdb, { email: 'ivy@shop.test' });
    const cookie = await loginAs(app, 'ivy@shop.test');
    await app.tdb.db.delete(schema.users).where(eq(schema.users.id, u.id));
    expect((await request(app, 'GET', '/me', { cookie })).status).toBe(401);
  });
});

describe('access control', () => {
  it('anonymous requests to protected routes are 401, public ones are open', async () => {
    expect((await request(app, 'GET', '/me')).status).toBe(401);
    expect((await request(app, 'GET', '/test/manager-only')).status).toBe(401);
    expect((await request(app, 'GET', '/test/public')).status).toBe(200);
    expect((await request(app, 'GET', '/health')).status).toBe(200);
  });

  it('role matrix: customers cannot use manager routes and vice versa', async () => {
    await createUser(app.tdb, { email: 'cust@shop.test', role: 'customer' });
    await createUser(app.tdb, { email: 'mgr@shop.test', role: 'manager' });
    const c = await loginAs(app, 'cust@shop.test');
    const m = await loginAs(app, 'mgr@shop.test');
    expect((await request(app, 'GET', '/test/manager-only', { cookie: c })).status).toBe(403);
    expect((await request(app, 'GET', '/test/manager-only', { cookie: m })).status).toBe(200);
    expect((await request(app, 'GET', '/test/customer-only', { cookie: c })).status).toBe(200);
    expect((await request(app, 'GET', '/test/customer-only', { cookie: m })).status).toBe(403);
  });

  it('role changes in the database take effect on the very next request', async () => {
    const u = await createUser(app.tdb, { email: 'promoted@shop.test', role: 'customer' });
    const cookie = await loginAs(app, u.email);
    expect((await request(app, 'GET', '/test/manager-only', { cookie })).status).toBe(403);
    await app.tdb.db.update(schema.users).set({ role: 'manager' }).where(eq(schema.users.id, u.id));
    expect((await request(app, 'GET', '/test/manager-only', { cookie })).status).toBe(200);
  });

  it('mass-assignment: a client cannot choose its own role at login', async () => {
    await createUser(app.tdb, { email: 'mass@shop.test', role: 'customer' });
    const r = await request(app, 'POST', '/auth/login', {
      body: { email: 'mass@shop.test', password: 'Password123!', role: 'manager' },
    });
    expect((r.json as { role: string }).role).toBe('customer');
  });
});

describe('Origin check (CSRF defence in depth)', () => {
  it('rejects state-changing requests from a foreign Origin, allows ours and non-browser clients', async () => {
    await createUser(app.tdb, { email: 'csrf@shop.test' });
    const body = { email: 'csrf@shop.test', password: 'Password123!' };
    expect(
      (
        await request(app, 'POST', '/auth/login', {
          body,
          headers: { Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(app, 'POST', '/auth/login', { body, headers: { Origin: 'null' } })).status,
    ).toBe(403);
    expect(
      (
        await request(app, 'POST', '/auth/login', {
          body,
          headers: { Origin: 'http://shop.test.evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(app, 'POST', '/auth/login', { body, headers: { Origin: 'http://shop.test' } }))
        .status,
    ).toBe(200);
    expect((await request(app, 'POST', '/auth/login', { body })).status).toBe(200);
  });

  it('a foreign-origin logout cannot log the victim out', async () => {
    await createUser(app.tdb, { email: 'csrf2@shop.test' });
    const cookie = await loginAs(app, 'csrf2@shop.test');
    const r = await request(app, 'POST', '/auth/logout', {
      cookie,
      headers: { Origin: 'https://evil.example' },
    });
    expect(r.status).toBe(403);
    expect((await request(app, 'GET', '/me', { cookie })).status).toBe(200);
  });
});

type Res = import('./harness').Res;
