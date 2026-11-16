import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-signature';

/** Header format (Stripe-like): `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">`. */
export function signPayload(secret: string, rawBody: string | Buffer, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  const mac = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  return `t=${t},v1=${mac}`;
}

/**
 * Verifies the signature over the RAW bytes (never over re-serialised JSON), in constant time,
 * and refuses stale timestamps so a captured request cannot be replayed much later.
 */
export function verifySignature(
  secret: string,
  header: string | string[] | undefined,
  rawBody: Buffer | undefined,
  now: Date,
  toleranceSeconds: number,
): boolean {
  if (typeof header !== 'string' || !rawBody || rawBody.length === 0) return false;
  const parts = new Map<string, string>();
  for (const p of header.split(',')) {
    const i = p.indexOf('=');
    if (i > 0) parts.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
  }
  const t = parts.get('t');
  const v1 = parts.get('v1');
  if (!t || !v1 || !/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
