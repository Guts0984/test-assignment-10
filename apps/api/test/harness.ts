import 'reflect-metadata';
import http from 'node:http';
import { type AddressInfo } from 'node:net';
import { type INestApplication, type Type } from '@nestjs/common';
import { createTestDatabase, hashPassword, schema, type TestDatabase } from '@shop/db';
import { createApp } from '../src/app';
import { type AppCtx, type Clock } from '../src/ctx';
import { parseEnv, type Env } from '../src/env';

export class FakeClock implements Clock {
  constructor(private ms = Date.parse('2026-06-01T10:00:00Z')) {}
  now = () => new Date(this.ms);
  set(d: Date | string) {
    this.ms = new Date(d).getTime();
  }
  advance(ms: number) {
    this.ms += ms;
  }
}

export const TEST_SECRETS = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef0123',
  WEBHOOK_SECRET: 'test-webhook-secret-0123456789abcdef012',
};

export type TestApp = {
  url: string;
  port: number;
  env: Env;
  ctx: AppCtx;
  clock: FakeClock;
  tdb: TestDatabase;
  app: INestApplication;
  close: () => Promise<void>;
};

export async function startTestApp(
  opts: {
    env?: Record<string, string>;
    extraModules?: Type<unknown>[];
    tdb?: TestDatabase;
    clock?: FakeClock;
  } = {},
): Promise<TestApp> {
  const tdb = opts.tdb ?? (await createTestDatabase());
  const clock = opts.clock ?? new FakeClock();
  // pick a free port first so WEBHOOK_URL (the stub posts to the api itself) is right from the start
  const port = await freePort();
  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: tdb.url,
    ...TEST_SECRETS,
    API_PORT: String(port),
    JOBS_ENABLED: 'false',
    ALLOWED_ORIGINS: 'http://shop.test',
    PUBLIC_WEB_URL: 'http://shop.test',
    ...opts.env,
  });
  const ctx: AppCtx = { db: tdb.db, env, clock };
  const app = await createApp({ ctx, extraModules: opts.extraModules, logger: false });
  await app.listen(port, '0.0.0.0');
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    env,
    ctx,
    clock,
    tdb,
    app,
    close: async () => {
      await app.close();
      if (!opts.tdb) await tdb.drop();
    },
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '0.0.0.0', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export type Res = {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: unknown;
};

/**
 * Real HTTP request from a chosen SOURCE address (127.0.0.2, 127.0.0.3, ... are all loopback on
 * Linux), so tests can play several distinct clients - an attacker and a victim - against the
 * same server.
 */
export function request(
  app: Pick<TestApp, 'port'>,
  method: string,
  path: string,
  o: {
    body?: unknown;
    rawBody?: string | Buffer;
    headers?: Record<string, string>;
    ip?: string;
    cookie?: string;
  } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    const headers: Record<string, string | number> = { ...(o.headers ?? {}) };
    if (payload !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(payload);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type'))
        headers['Content-Type'] = 'application/json';
    }
    if (o.cookie) headers['Cookie'] = o.cookie;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: app.port,
        method,
        path,
        headers,
        localAddress: o.ip,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let cachedHash: Promise<string> | undefined;
export async function createUser(
  tdb: TestDatabase,
  o: { email?: string; role?: 'customer' | 'manager'; password?: string } = {},
) {
  const password = o.password ?? 'Password123!';
  const hash =
    password === 'Password123!'
      ? await (cachedHash ??= hashPassword(password))
      : await hashPassword(password);
  const email = o.email ?? `user${Math.random().toString(36).slice(2, 8)}@shop.test`;
  const [u] = await tdb.db
    .insert(schema.users)
    .values({ email, name: 'Test User', passwordHash: hash, role: o.role ?? 'customer' })
    .returning();
  return { ...u!, password };
}

export function cookieFrom(res: Res): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return (first ?? '').split(';')[0] ?? '';
}

export async function loginAs(
  app: TestApp,
  email: string,
  password = 'Password123!',
  ip?: string,
): Promise<string> {
  const r = await request(app, 'POST', '/auth/login', { body: { email, password }, ip });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${r.text}`);
  return cookieFrom(r);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
