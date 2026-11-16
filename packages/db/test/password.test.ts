import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password';

describe('password hashing', () => {
  it('verifies the right password and rejects wrong ones', async () => {
    const h = await hashPassword('s3cret!');
    expect(await verifyPassword('s3cret!', h)).toBe(true);
    expect(await verifyPassword('s3cret', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });
  it('uses a random salt', async () => {
    expect(await hashPassword('a')).not.toBe(await hashPassword('a'));
  });
  it('never throws on malformed stored hashes (returns false)', async () => {
    for (const bad of [
      '',
      'x',
      'scrypt$1$2$3$4',
      'scrypt$a$b$c$d$e',
      'bcrypt$1$2$3$4$5',
      'scrypt$16384$8$1$!!$!!',
      'scrypt$999999999$8$1$AAAA$AAAA',
    ]) {
      expect(await verifyPassword('x', bad), bad).toBe(false);
    }
  });
  it('handles very long and unicode passwords', async () => {
    const pw = '🔥'.repeat(500);
    expect(await verifyPassword(pw, await hashPassword(pw))).toBe(true);
  });
});
