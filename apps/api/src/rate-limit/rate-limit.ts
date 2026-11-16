import { hitRateLimit, resetRateLimit, undoRateLimitHit, windowStartFor } from '@shop/db';
import { type AppCtx } from '../ctx';
import { tooManyRequests } from '../http/errors';

export type LimitResult = { allowed: boolean; count: number; retryAfterSec: number };

/**
 * Atomically counts one hit for `key` in the current fixed window and says whether the caller
 * is still within `max`. The increment happens BEFORE the decision (one UPSERT ... RETURNING),
 * so parallel requests cannot all slip under the limit.
 */
export async function consume(
  ctx: AppCtx,
  key: string,
  opts: { windowSeconds: number; max: number },
): Promise<LimitResult & { windowStart: Date }> {
  const now = ctx.clock.now();
  const windowStart = windowStartFor(now, opts.windowSeconds);
  const count = await hitRateLimit(ctx.db, key, windowStart);
  const retryAfterSec = Math.ceil(
    (windowStart.getTime() + opts.windowSeconds * 1000 - now.getTime()) / 1000,
  );
  return { allowed: count <= opts.max, count, retryAfterSec, windowStart };
}

export async function giveBack(ctx: AppCtx, key: string, windowStart: Date): Promise<void> {
  await undoRateLimitHit(ctx.db, key, windowStart);
}

export async function clearKey(ctx: AppCtx, key: string): Promise<void> {
  await resetRateLimit(ctx.db, key);
}

export async function enforce(
  ctx: AppCtx,
  key: string,
  opts: { windowSeconds: number; max: number },
): Promise<void> {
  const r = await consume(ctx, key, opts);
  if (!r.allowed) throw tooManyRequests(r.retryAfterSec);
}
