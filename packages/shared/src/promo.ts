import { calcPromoDiscount, type Kopecks, type PromoDiscountRule } from './money';

export type PromoRecord = PromoDiscountRule & {
  code: string;
  minOrder: Kopecks;
  startsAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  used: number;
  oncePerCustomer: boolean;
  active: boolean;
};

export const PROMO_REJECT_REASONS = [
  'not_found',
  'inactive',
  'not_started',
  'expired',
  'already_used',
  'limit_reached',
  'min_order',
] as const;
export type PromoRejectReason = (typeof PROMO_REJECT_REASONS)[number];

export type PromoCheck =
  { ok: true; discount: Kopecks } | { ok: false; reason: PromoRejectReason; minOrder?: Kopecks };

/** Codes are case-insensitive: we store and compare the trimmed, upper-cased form. */
export function normalizePromoCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Pure promo validation shared by cart preview (web + api) and checkout (api, inside the transaction).
 * Check order is part of the contract: the most "permanent" problems are reported first.
 */
export function validatePromo(
  promo: PromoRecord | null,
  ctx: { now: Date; subtotal: Kopecks; customerAlreadyUsed: boolean },
): PromoCheck {
  if (!promo) return { ok: false, reason: 'not_found' };
  if (!promo.active) return { ok: false, reason: 'inactive' };
  if (promo.startsAt && ctx.now < promo.startsAt) return { ok: false, reason: 'not_started' };
  if (promo.expiresAt && ctx.now >= promo.expiresAt) return { ok: false, reason: 'expired' };
  if (promo.oncePerCustomer && ctx.customerAlreadyUsed)
    return { ok: false, reason: 'already_used' };
  if (promo.maxUses !== null && promo.used >= promo.maxUses)
    return { ok: false, reason: 'limit_reached' };
  if (ctx.subtotal < promo.minOrder)
    return { ok: false, reason: 'min_order', minOrder: promo.minOrder };
  return { ok: true, discount: calcPromoDiscount(promo, ctx.subtotal) };
}
