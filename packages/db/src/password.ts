import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt is built into Node: no native modules to compile inside the Docker image.
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
  });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/** Constant-time comparison. Never throws on malformed hashes: returns false. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (![N, R, P].every(Number.isSafeInteger)) return false;
  // sanity bounds: a corrupted/hostile hash must neither be accepted nor make us allocate GBs
  if (N < 2 || N > 2 ** 17 || (N & (N - 1)) !== 0 || R < 1 || R > 16 || P < 1 || P > 4)
    return false;
  try {
    const expected = Buffer.from(hashB64, 'base64');
    const salt = Buffer.from(saltB64, 'base64');
    // an empty key would make "any password" match an empty digest
    if (expected.length < 16 || salt.length < 8) return false;
    const actual = await scryptAsync(password, salt, expected.length, {
      N,
      r: R,
      p: P,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
