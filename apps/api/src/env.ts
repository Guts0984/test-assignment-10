import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);
const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);

/**
 * Every setting of the api. Secrets (DATABASE_URL, SESSION_SECRET, WEBHOOK_SECRET) have no
 * defaults: the process refuses to start without them. Everything else has a safe default.
 */
const shape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: int(4000, 1, 65535),
  API_HOST: z.string().default('0.0.0.0'),

  // --- secrets: required
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  WEBHOOK_SECRET: z.string().min(32, 'WEBHOOK_SECRET must be at least 32 characters'),

  // --- http / security
  ALLOWED_ORIGINS: csv.default(['http://localhost:8088', 'http://localhost:3000']),
  COOKIE_SECURE: bool.default(false),
  SESSION_TTL_HOURS: int(168, 1),
  TRUST_PROXY_HOPS: int(0, 0, 10),
  BODY_LIMIT_KB: int(100, 1, 10_000),

  // --- business rules
  RESERVATION_MINUTES: int(15, 1),
  RETURN_WINDOW_DAYS: int(14, 1),
  // stops one customer from hoarding the whole stock with unpaid reservations
  MAX_PENDING_ORDERS: int(5, 1),
  DELIVERY_FEE_KOPECKS: int(10_000),
  FREE_DELIVERY_FROM_KOPECKS: int(200_000),

  // --- payment stub
  WEBHOOK_URL: z.string().url().optional(),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:8088'),
  STUB_DELAY_SECONDS: int(30, 0),
  WEBHOOK_TOLERANCE_SECONDS: int(300, 1),

  // --- jobs
  JOBS_ENABLED: bool.default(true),
  JOBS_POLL_MS: int(1000, 10),

  // --- rate limiting (PostgreSQL counters)
  LOGIN_WINDOW_SECONDS: int(900, 1),
  LOGIN_MAX_PER_IP: int(30, 1),
  LOGIN_MAX_PER_IP_ACCOUNT: int(5, 1),
  API_RATE_WINDOW_SECONDS: int(60, 1),
  API_RATE_MAX_PER_IP: int(600, 1),
  WEBHOOK_BAD_SIGNATURE_MAX_PER_MINUTE: int(30, 1),
};

export const envSchema = z.object(shape).transform((e) => ({
  ...e,
  WEBHOOK_URL: e.WEBHOOK_URL ?? `http://localhost:${e.API_PORT}/payments/webhook`,
}));

export type Env = z.infer<typeof envSchema>;

/** Parses and validates; throws one readable error listing every problem. */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = envSchema.safeParse(source);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return r.data;
}
