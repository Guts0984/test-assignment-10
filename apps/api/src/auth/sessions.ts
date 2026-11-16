import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { schema } from '@shop/db';
import { type AppCtx } from '../ctx';
import { type SessionUser } from '../http/types';

export const SESSION_COOKIE = 'sid';

/** Only an HMAC of the token is stored: a leaked database cannot be used to hijack sessions. */
export function hashToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

export async function createSession(
  ctx: AppCtx,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + ctx.env.SESSION_TTL_HOURS * 3_600_000);
  await ctx.db.insert(schema.sessions).values({
    tokenHash: hashToken(ctx.env.SESSION_SECRET, token),
    userId,
    expiresAt,
    createdAt: now,
  });
  return { token, expiresAt };
}

export async function findSessionUser(ctx: AppCtx, token: string): Promise<SessionUser | null> {
  // base64url of 32 bytes is 43 chars; anything else cannot be ours: don't even hit the database
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const rows = await ctx.db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      role: schema.users.role,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(
      and(
        eq(schema.sessions.tokenHash, hashToken(ctx.env.SESSION_SECRET, token)),
        gt(schema.sessions.expiresAt, ctx.clock.now()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function destroySession(ctx: AppCtx, token: string): Promise<void> {
  await ctx.db
    .delete(schema.sessions)
    .where(eq(schema.sessions.tokenHash, hashToken(ctx.env.SESSION_SECRET, token)));
}

export async function purgeExpiredSessions(ctx: AppCtx): Promise<void> {
  await ctx.db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, ctx.clock.now()));
}
