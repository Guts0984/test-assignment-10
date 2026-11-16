import { and, eq, sql } from 'drizzle-orm';
import { schema, type Executor } from '@shop/db';
import { normalizePromoCode, type PromoRecord } from '@shop/shared';

const { promoCodes, promoRedemptions } = schema;

export type PromoRow = typeof promoCodes.$inferSelect;

export const toPromoRecord = (p: PromoRow): PromoRecord => ({
  code: p.code,
  type: p.type,
  value: p.value,
  minOrder: p.minOrder,
  startsAt: p.startsAt,
  expiresAt: p.expiresAt,
  maxUses: p.maxUses,
  used: p.used,
  oncePerCustomer: p.oncePerCustomer,
  active: p.active,
});

export async function findPromoByCode(
  ex: Executor,
  code: string,
  opts: { lock?: boolean } = {},
): Promise<PromoRow | null> {
  const q = ex
    .select()
    .from(promoCodes)
    .where(eq(promoCodes.code, normalizePromoCode(code)))
    .limit(1);
  const rows = await (opts.lock ? q.for('update') : q);
  return rows[0] ?? null;
}

export async function customerUsedPromo(
  ex: Executor,
  promoId: string,
  userId: string,
): Promise<boolean> {
  const r = await ex
    .select({ id: promoRedemptions.id })
    .from(promoRedemptions)
    .where(and(eq(promoRedemptions.promoId, promoId), eq(promoRedemptions.userId, userId)))
    .limit(1);
  return r.length > 0;
}

/**
 * Takes one use of the promo. MUST run while holding the promo row lock (findPromoByCode with lock)
 * or inside the same statement guard: the UPDATE only succeeds while `used < max_uses`, and the
 * partial unique index rejects a second redemption by the same customer.
 */
export async function redeemPromo(
  ex: Executor,
  promo: PromoRow,
  userId: string,
  orderId: string,
  now: Date,
): Promise<boolean> {
  const updated = await ex
    .update(promoCodes)
    .set({ used: sql`${promoCodes.used} + 1` })
    .where(
      and(
        eq(promoCodes.id, promo.id),
        sql`(${promoCodes.maxUses} is null or ${promoCodes.used} < ${promoCodes.maxUses})`,
      ),
    )
    .returning({ id: promoCodes.id });
  if (updated.length === 0) return false;
  await ex.insert(promoRedemptions).values({
    promoId: promo.id,
    userId,
    orderId,
    oncePerCustomer: promo.oncePerCustomer,
    createdAt: now,
  });
  return true;
}

/** Gives the use back (order cancelled / expired). */
export async function releasePromo(ex: Executor, orderId: string): Promise<void> {
  const del = await ex
    .delete(promoRedemptions)
    .where(eq(promoRedemptions.orderId, orderId))
    .returning({ promoId: promoRedemptions.promoId });
  for (const r of del) {
    await ex
      .update(promoCodes)
      .set({ used: sql`greatest(${promoCodes.used} - 1, 0)` })
      .where(eq(promoCodes.id, r.promoId));
  }
}
