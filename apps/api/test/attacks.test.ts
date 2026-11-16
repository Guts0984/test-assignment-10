import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, loginAs, request, startTestApp, type TestApp } from './harness';

/**
 * A REAL server on a REAL socket and REAL PostgreSQL. The "attacker" and the "victim" connect
 * from different source addresses (127.0.0.x), exactly like two machines would.
 */
const ATTACKER = '127.0.0.2';
const VICTIM_HOME = '127.0.0.3';
const BYSTANDER = '127.0.0.4';

const login = (
  app: TestApp,
  email: string,
  password: string,
  ip: string | undefined,
  headers?: Record<string, string>,
) => request(app, 'POST', '/auth/login', { body: { email, password }, ip, headers });

describe('login brute force', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp({
      env: {
        LOGIN_MAX_PER_IP_ACCOUNT: '5',
        LOGIN_MAX_PER_IP: '30',
        API_RATE_MAX_PER_IP: '100000',
        LOGIN_WINDOW_SECONDS: '900',
      },
    });
  });
  afterAll(async () => app.close());

  it('guessing one account from one address is cut off after 5 tries - and the owner, elsewhere, still gets in', async () => {
    const victim = await createUser(app.tdb, {
      email: 'victim@shop.test',
      password: 'CorrectHorse1!',
    });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await login(app, victim.email, `guess-${i}`, ATTACKER)).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);

    // even the CORRECT password is refused for the attacker's address while blocked...
    const attackerWithRightPassword = await login(app, victim.email, victim.password, ATTACKER);
    expect(attackerWithRightPassword.status).toBe(429);
    expect(Number(attackerWithRightPassword.headers['retry-after'])).toBeGreaterThan(0);

    // ...but the real owner on another device/address is NOT locked out
    const owner = await login(app, victim.email, victim.password, VICTIM_HOME);
    expect(owner.status).toBe(200);
  });

  it('the attacker can still try OTHER accounts until the per-address limit (they are limited per pair)', async () => {
    await createUser(app.tdb, { email: 'other@shop.test' });
    const r = await login(app, 'other@shop.test', 'x', ATTACKER);
    expect(r.status).toBe(401); // different pair => own counter
  });

  it('100 PARALLEL guesses: exactly 5 reach the password check, the rest are rejected (atomic counting)', async () => {
    const victim = await createUser(app.tdb, {
      email: 'parallel@shop.test',
      password: 'CorrectHorse1!',
    });
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => login(app, victim.email, `p-${i}`, '127.0.0.9')),
    );
    expect(results.filter((r) => r.status === 401)).toHaveLength(5);
    expect(results.filter((r) => r.status === 429)).toHaveLength(95);
    // no guess slipped through as a success
    expect(results.some((r) => r.status === 200)).toBe(false);
  });

  it('spraying many accounts from one address trips the per-address limit (30)', async () => {
    const results: number[] = [];
    for (let i = 0; i < 40; i++)
      results.push((await login(app, `spray${i}@shop.test`, 'x', '127.0.0.10')).status);
    expect(results.filter((s) => s === 401)).toHaveLength(30);
    expect(results.filter((s) => s === 429)).toHaveLength(10);
    // a bystander on another address is completely unaffected
    const real = await createUser(app.tdb, { email: 'bystander@shop.test' });
    expect((await login(app, real.email, real.password, BYSTANDER)).status).toBe(200);
  });

  it('a successful login resets the failed counter for that address+account', async () => {
    const u = await createUser(app.tdb, {
      email: 'forgetful@shop.test',
      password: 'CorrectHorse1!',
    });
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++)
        expect((await login(app, u.email, 'wrong', '127.0.0.11')).status).toBe(401);
      expect((await login(app, u.email, u.password, '127.0.0.11')).status).toBe(200);
    }
  });

  it('limits expire with the window (fake clock)', async () => {
    const u = await createUser(app.tdb, { email: 'window@shop.test', password: 'CorrectHorse1!' });
    for (let i = 0; i < 5; i++) await login(app, u.email, 'bad', '127.0.0.12');
    expect((await login(app, u.email, u.password, '127.0.0.12')).status).toBe(429);
    app.clock.advance(901 * 1000);
    expect((await login(app, u.email, u.password, '127.0.0.12')).status).toBe(200);
  });

  it('case/whitespace variations of the e-mail share ONE counter (cannot dodge the limit)', async () => {
    const u = await createUser(app.tdb, { email: 'case@shop.test', password: 'CorrectHorse1!' });
    const variants = [
      'case@shop.test',
      'CASE@shop.test',
      ' Case@Shop.Test',
      'case@SHOP.test',
      'CaSe@shop.test',
      'case@shop.TEST',
      'cASE@shop.test',
    ];
    const statuses: number[] = [];
    for (const v of variants) statuses.push((await login(app, v, 'bad', '127.0.0.13')).status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    expect(u.email).toBe('case@shop.test');
  });
});

describe('spoofing the client address', () => {
  it('with no trusted proxy, X-Forwarded-For is ignored: rotating it does not evade the limit', async () => {
    const app = await startTestApp({
      env: { TRUST_PROXY_HOPS: '0', LOGIN_MAX_PER_IP_ACCOUNT: '5', API_RATE_MAX_PER_IP: '100000' },
    });
    try {
      await createUser(app.tdb, { email: 'spoof@shop.test' });
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        statuses.push(
          (
            await login(app, 'spoof@shop.test', 'bad', ATTACKER, {
              'X-Forwarded-For': `10.0.0.${i}`,
            })
          ).status,
        );
      }
      expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    } finally {
      await app.close();
    }
  });

  it('behind one trusted proxy (nginx) forged left-hand entries do not help; real clients stay separate', async () => {
    const app = await startTestApp({
      env: { TRUST_PROXY_HOPS: '1', LOGIN_MAX_PER_IP_ACCOUNT: '5', API_RATE_MAX_PER_IP: '100000' },
    });
    try {
      const u = await createUser(app.tdb, {
        email: 'behindproxy@shop.test',
        password: 'CorrectHorse1!',
      });
      // the proxy (127.0.0.1) appends the address it really saw as the LAST entry
      const viaProxy = (realClient: string, forged: string) => ({
        'X-Forwarded-For': `${forged}, ${realClient}`,
      });
      const statuses: number[] = [];
      for (let i = 0; i < 9; i++) {
        statuses.push(
          (await login(app, u.email, 'bad', undefined, viaProxy('203.0.113.66', `7.7.7.${i}`)))
            .status,
        );
      }
      expect(statuses.filter((s) => s === 401)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(4);
      // the owner, seen by the proxy as a different address, logs in fine
      expect(
        (await login(app, u.email, u.password, undefined, viaProxy('198.51.100.7', '1.1.1.1')))
          .status,
      ).toBe(200);
      // and a forged entry that merely CLAIMS to be the owner's address cannot make the attacker "become" them
      expect(
        (await login(app, u.email, u.password, undefined, viaProxy('203.0.113.66', '198.51.100.7')))
          .status,
      ).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('garbage X-Forwarded-For values never crash the server', async () => {
    const app = await startTestApp({ env: { TRUST_PROXY_HOPS: '1' } });
    try {
      for (const v of [
        '',
        ',,,',
        'a'.repeat(10_000),
        "'; DROP TABLE users;--",
        '::1, ::ffff:1.2.3.4',
        '999.999.999.999',
      ]) {
        const r = await request(app, 'GET', '/health', {
          headers: { 'X-Forwarded-For': v },
        });
        expect(r.status, v.slice(0, 20)).toBeLessThan(500);
      }
    } finally {
      await app.close();
    }
  });
});

describe('request flooding (denial of service attempt) - everyone else must stay up', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp({
      env: {
        API_RATE_MAX_PER_IP: '50',
        API_RATE_WINDOW_SECONDS: '60',
        LOGIN_MAX_PER_IP: '1000',
        LOGIN_MAX_PER_IP_ACCOUNT: '1000',
      },
    });
  });
  afterAll(async () => app.close());

  it('a flooding address is throttled while legitimate users keep working at the same time', async () => {
    const good = await createUser(app.tdb, { email: 'legit@shop.test' });
    const cookie = await loginAs(app, good.email, good.password, VICTIM_HOME);

    // 400 requests as fast as possible from the attacker, while the legit user keeps browsing
    const flood = Array.from({ length: 400 }, () =>
      request(app, 'GET', '/me', { ip: ATTACKER, cookie: 'sid=x' }),
    );
    const legit: Promise<number>[] = [];
    for (let i = 0; i < 20; i++)
      legit.push(request(app, 'GET', '/me', { ip: VICTIM_HOME, cookie }).then((r) => r.status));
    const [floodRes, legitStatuses] = await Promise.all([Promise.all(flood), Promise.all(legit)]);

    const throttled = floodRes.filter((r) => r.status === 429).length;
    const passedThrough = floodRes.filter((r) => r.status === 401).length;
    expect(passedThrough).toBeLessThanOrEqual(50);
    expect(throttled).toBeGreaterThanOrEqual(350);
    expect(floodRes.every((r) => r.status === 401 || r.status === 429)).toBe(true); // never a 5xx
    expect(legitStatuses.every((s) => s === 200)).toBe(true);
    expect(floodRes.find((r) => r.status === 429)!.headers['retry-after']).toBeDefined();
  });

  it("after the window passes the attacker's address works again (no permanent ban to abuse)", async () => {
    app.clock.advance(61_000);
    expect((await request(app, 'GET', '/me', { ip: ATTACKER })).status).toBe(401);
  });

  it('the health endpoint is never rate limited (orchestrator probes keep working)', async () => {
    const rs = await Promise.all(
      Array.from({ length: 120 }, () => request(app, 'GET', '/health', { ip: '127.0.0.20' })),
    );
    expect(rs.every((r) => r.status === 200)).toBe(true);
  });

  it('flooding from one address does not slow down another address (fast 429s)', async () => {
    const t0 = performance.now();
    const r = await request(app, 'GET', '/health', { ip: '127.0.0.21' });
    expect(r.status).toBe(200);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
