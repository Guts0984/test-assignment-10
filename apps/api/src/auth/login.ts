import { eq } from 'drizzle-orm';
import { hashPassword, schema, verifyPassword } from '@shop/db';
import { type LoginInput } from '@shop/shared';
import { type AppCtx } from '../ctx';
import { AppError, tooManyRequests } from '../http/errors';
import { clearKey, consume, giveBack } from '../rate-limit/rate-limit';
import { createSession } from './sessions';

/** Constant-cost decoy so "unknown e-mail" and "wrong password" take the same time. */
let dummyHash: Promise<string> | undefined;
const decoy = () => (dummyHash ??= hashPassword('decoy-password-never-matches'));

export const loginKeys = (ip: string, email: string) => ({
  ip: `login:ip:${ip}`,
  pair: `login:pair:${ip}:${email}`,
});

/**
 * Login with two independent throttles:
 *  - per IP address            (stops one machine from spraying many accounts)
 *  - per IP address + account  (stops one machine from guessing one account's password)
 * There is deliberately NO per-account-only counter: an attacker elsewhere cannot lock the
 * real owner out. Attempts are counted atomically BEFORE the password is checked, so a burst
 * of parallel guesses cannot exceed the limit; a successful login gives its hit back.
 */
export async function login(
  ctx: AppCtx,
  input: LoginInput,
  ip: string,
): Promise<{
  user: { id: string; email: string; name: string; role: 'customer' | 'manager' };
  token: string;
  expiresAt: Date;
}> {
  const keys = loginKeys(ip, input.email);
  const win = ctx.env.LOGIN_WINDOW_SECONDS;
  const byIp = await consume(ctx, keys.ip, { windowSeconds: win, max: ctx.env.LOGIN_MAX_PER_IP });
  const byPair = await consume(ctx, keys.pair, {
    windowSeconds: win,
    max: ctx.env.LOGIN_MAX_PER_IP_ACCOUNT,
  });
  if (!byIp.allowed || !byPair.allowed) {
    throw tooManyRequests(
      Math.max(byIp.allowed ? 0 : byIp.retryAfterSec, byPair.allowed ? 0 : byPair.retryAfterSec),
    );
  }

  const rows = await ctx.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, input.email))
    .limit(1);
  const user = rows[0];
  const ok = await verifyPassword(input.password, user?.passwordHash ?? (await decoy()));
  if (!user || !ok) throw new AppError(401, 'unauthorized', 'Invalid email or password');

  // success: forget the failed guesses for this pair, and don't charge the IP bucket
  await clearKey(ctx, keys.pair);
  await giveBack(ctx, keys.ip, byIp.windowStart);
  const session = await createSession(ctx, user.id);
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, ...session };
}
