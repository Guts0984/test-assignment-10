import { claimJobs, completeJob, failJob, purgeRateLimits } from '@shop/db';
import { webhookEventSchema } from '@shop/shared';
import { type AppCtx } from '../ctx';
import { expireOrder } from '../orders/lifecycle';
import { deliverWebhook } from '../payments/stub';
import { purgeExpiredSessions } from '../auth/sessions';

const MAX_ATTEMPTS = 8;

type Handler = (ctx: AppCtx, payload: unknown) => Promise<void>;

/** Job type -> handler. Handlers must be idempotent: a job can run twice after a crash. */
const handlers: Record<string, Handler> = {
  expire_order: async (ctx, payload) => {
    const { orderId } = payload as { orderId?: unknown };
    if (typeof orderId !== 'string') throw new Error('expire_order: orderId missing');
    await expireOrder(ctx, orderId);
  },
  deliver_webhook: async (ctx, payload) => {
    const event = webhookEventSchema.parse(payload);
    await deliverWebhook(ctx, event);
  },
};

/** Runs every job that is due according to ctx.clock (tests move a fake clock and call this). Returns how many ran. */
export async function runDueJobs(ctx: AppCtx, opts: { limit?: number } = {}): Promise<number> {
  const jobs = await claimJobs(ctx.db, { now: ctx.clock.now(), limit: opts.limit ?? 50 });
  for (const job of jobs) {
    const handler = handlers[job.type];
    try {
      if (!handler) throw new Error(`unknown job type "${job.type}"`);
      await handler(ctx, job.payload);
      await completeJob(ctx.db, job.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const permanent = !handler || job.attempts >= MAX_ATTEMPTS;
      const backoffMs = Math.min(2 ** job.attempts * 5000, 15 * 60_000);
      await failJob(
        ctx.db,
        job.id,
        message,
        permanent ? null : new Date(ctx.clock.now().getTime() + backoffMs),
      );
    }
  }
  return jobs.length;
}

/** Housekeeping: old rate-limit windows and expired sessions. */
export async function runMaintenance(ctx: AppCtx): Promise<void> {
  const day = 86_400_000;
  await purgeRateLimits(ctx.db, new Date(ctx.clock.now().getTime() - day));
  await purgeExpiredSessions(ctx);
}
