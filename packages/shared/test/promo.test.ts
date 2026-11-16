import { describe, expect, it } from 'vitest';
import { normalizePromoCode, validatePromo, type PromoRecord } from '../src';

const base: PromoRecord = {
  code: 'SALE',
  type: 'percent',
  value: 10,
  minOrder: 50_000,
  startsAt: null,
  expiresAt: null,
  maxUses: null,
  used: 0,
  oncePerCustomer: true,
  active: true,
};
const now = new Date('2026-01-10T12:00:00Z');
const ctx = { now, subtotal: 100_000, customerAlreadyUsed: false };

describe('validatePromo', () => {
  it('accepts a valid code and computes the discount', () => {
    expect(validatePromo(base, ctx)).toEqual({ ok: true, discount: 10_000 });
  });
  it('reports every rejection reason', () => {
    expect(validatePromo(null, ctx)).toEqual({ ok: false, reason: 'not_found' });
    expect(validatePromo({ ...base, active: false }, ctx)).toMatchObject({ reason: 'inactive' });
    expect(validatePromo({ ...base, startsAt: new Date('2026-02-01') }, ctx)).toMatchObject({
      reason: 'not_started',
    });
    expect(validatePromo({ ...base, expiresAt: new Date('2026-01-01') }, ctx)).toMatchObject({
      reason: 'expired',
    });
    expect(validatePromo(base, { ...ctx, customerAlreadyUsed: true })).toMatchObject({
      reason: 'already_used',
    });
    expect(validatePromo({ ...base, maxUses: 5, used: 5 }, ctx)).toMatchObject({
      reason: 'limit_reached',
    });
    expect(validatePromo(base, { ...ctx, subtotal: 49_999 })).toEqual({
      ok: false,
      reason: 'min_order',
      minOrder: 50_000,
    });
  });
  it('boundaries: expiry instant is exclusive, min order and last use are inclusive', () => {
    expect(validatePromo({ ...base, expiresAt: now }, ctx)).toMatchObject({ reason: 'expired' });
    expect(validatePromo({ ...base, startsAt: now }, ctx).ok).toBe(true);
    expect(validatePromo(base, { ...ctx, subtotal: 50_000 }).ok).toBe(true);
    expect(validatePromo({ ...base, maxUses: 5, used: 4 }, ctx).ok).toBe(true);
  });
  it('per-customer rule can be switched off', () => {
    expect(
      validatePromo({ ...base, oncePerCustomer: false }, { ...ctx, customerAlreadyUsed: true }).ok,
    ).toBe(true);
  });
  it('codes are case-insensitive', () => {
    expect(normalizePromoCode('  sAle ')).toBe('SALE');
  });
});
