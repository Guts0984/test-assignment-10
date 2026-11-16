import { isIP } from 'node:net';

/** "::ffff:1.2.3.4" -> "1.2.3.4"; lower-cases IPv6. */
export function normalizeIp(ip: string): string {
  const v = ip.trim().toLowerCase();
  return v.startsWith('::ffff:') && isIP(v.slice(7)) === 4 ? v.slice(7) : v;
}

/**
 * The client address used for rate limiting.
 *
 * `trustedHops` = how many reverse proxies sit in front of the api and append to X-Forwarded-For
 * (nginx = 1). We take the entry written by the NEAREST trusted proxy: counted from the RIGHT,
 * because everything to the left of it is client-controlled and can be forged. With 0 hops the
 * header is ignored completely.
 */
export function getClientIp(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedHops: number,
): string {
  const socket = normalizeIp(socketAddress ?? '') || 'unknown';
  if (trustedHops <= 0) return socket;
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const list = raw
    .split(',')
    .map((s) => normalizeIp(s))
    .filter(Boolean);
  const candidate = list[list.length - trustedHops];
  return candidate && isIP(candidate) !== 0 ? candidate : socket;
}
