import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env';

const secrets = {
  DATABASE_URL: 'postgres://u:p@h:5432/d',
  SESSION_SECRET: 'x'.repeat(32),
  WEBHOOK_SECRET: 'y'.repeat(32),
};

describe('env.ts', () => {
  it('gives defaults to every non-sensitive variable', () => {
    const e = parseEnv(secrets);
    expect(e.API_PORT).toBe(4000);
    expect(e.RESERVATION_MINUTES).toBe(15);
    expect(e.RETURN_WINDOW_DAYS).toBe(14);
    expect(e.DELIVERY_FEE_KOPECKS).toBe(10_000);
    expect(e.FREE_DELIVERY_FROM_KOPECKS).toBe(200_000);
    expect(e.STUB_DELAY_SECONDS).toBe(30);
    expect(e.COOKIE_SECURE).toBe(false);
    expect(e.JOBS_ENABLED).toBe(true);
    expect(e.TRUST_PROXY_HOPS).toBe(0);
    expect(e.WEBHOOK_URL).toBe('http://localhost:4000/payments/webhook');
    expect(e.ALLOWED_ORIGINS).toContain('http://localhost:8080');
  });
  it('has NO defaults for secrets and lists every missing one', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL[\s\S]*SESSION_SECRET[\s\S]*WEBHOOK_SECRET/);
  });
  it('rejects short secrets', () => {
    expect(() => parseEnv({ ...secrets, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(() => parseEnv({ ...secrets, WEBHOOK_SECRET: 'short' })).toThrow(/WEBHOOK_SECRET/);
  });
  it('unboxes strings into typed values', () => {
    const e = parseEnv({
      ...secrets,
      API_PORT: '8123',
      COOKIE_SECURE: 'true',
      JOBS_ENABLED: '0',
      ALLOWED_ORIGINS: 'https://a.test, https://b.test ,',
      TRUST_PROXY_HOPS: '1',
    });
    expect(e.API_PORT).toBe(8123);
    expect(e.COOKIE_SECURE).toBe(true);
    expect(e.JOBS_ENABLED).toBe(false);
    expect(e.ALLOWED_ORIGINS).toEqual(['https://a.test', 'https://b.test']);
    expect(e.TRUST_PROXY_HOPS).toBe(1);
  });
  it('rejects nonsense values instead of silently coercing', () => {
    expect(() => parseEnv({ ...secrets, API_PORT: 'abc' })).toThrow(/API_PORT/);
    expect(() => parseEnv({ ...secrets, API_PORT: '70000' })).toThrow(/API_PORT/);
    expect(() => parseEnv({ ...secrets, COOKIE_SECURE: 'maybe' })).toThrow(/COOKIE_SECURE/);
    expect(() => parseEnv({ ...secrets, RESERVATION_MINUTES: '-5' })).toThrow(
      /RESERVATION_MINUTES/,
    );
    expect(() => parseEnv({ ...secrets, WEBHOOK_URL: 'not a url' })).toThrow(/WEBHOOK_URL/);
  });
  it('the shipped .env.example is itself a valid configuration', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const text = fs.readFileSync(path.resolve(__dirname, '../../../.env.example'), 'utf8');
    const vars: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const m = /^([A-Z0-9_]+)=([^#]*?)\s*(?:#.*)?$/.exec(line);
      if (m) vars[m[1]!] = m[2]!;
    }
    const e = parseEnv(vars);
    expect(e.DATABASE_URL).toContain('postgres://');
    expect(e.TRUST_PROXY_HOPS).toBe(1);
  });
});
