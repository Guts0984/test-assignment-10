import { badRequest } from './errors';

/** Opaque keyset cursor: base64url(JSON). Tampered cursors are plain 400s, never 500s. */
export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, string | number>>(
  cursor: string,
  check: (v: Record<string, unknown>) => T | null,
): T {
  try {
    const raw: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const v = check(raw as Record<string, unknown>);
      if (v) return v;
    }
  } catch {
    /* fall through */
  }
  throw badRequest('Invalid cursor');
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
