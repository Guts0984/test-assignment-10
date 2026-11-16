import { describe, expect, it } from 'vitest';
import {
  loginSchema,
  productUpdateSchema,
  orderCreateSchema,
  payBodySchema,
  productQuerySchema,
  promoCreateSchema,
  returnCreateSchema,
  salesQuerySchema,
  webhookEventSchema,
} from '../src';

const uuid = '3f0f2d1c-8f5e-4c3a-9a55-0d6e7a1b2c3d';

describe('schemas reject hostile input', () => {
  it('login: normalises email, rejects non-strings and huge passwords', () => {
    expect(loginSchema.parse({ email: '  A@B.io ', password: 'x' }).email).toBe('a@b.io');
    expect(loginSchema.safeParse({ email: { $ne: 1 }, password: 'x' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.io', password: 'x'.repeat(201) }).success).toBe(
      false,
    );
    expect(loginSchema.safeParse(null).success).toBe(false);
  });
  it('courier order needs an address', () => {
    expect(orderCreateSchema.safeParse({ deliveryMethod: 'courier' }).success).toBe(false);
    expect(orderCreateSchema.safeParse({ deliveryMethod: 'pickup' }).success).toBe(true);
    expect(orderCreateSchema.safeParse({ deliveryMethod: 'drone' }).success).toBe(false);
  });
  it('returnUrl must be a same-site path (no open redirect)', () => {
    for (const bad of [
      '//evil.com',
      'https://evil.com',
      '/\\evil.com',
      'javascript:alert(1)',
      '/a b',
    ]) {
      expect(payBodySchema.safeParse({ returnUrl: bad }).success, bad).toBe(false);
    }
    expect(payBodySchema.safeParse({ returnUrl: '/uk/orders/1' }).success).toBe(true);
  });
  it('product query: bad numbers and inverted price range are rejected', () => {
    expect(productQuerySchema.safeParse({ minPrice: '10', maxPrice: '5' }).success).toBe(false);
    expect(productQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(productQuerySchema.safeParse({ minPrice: 'abc' }).success).toBe(false);
    expect(productQuerySchema.safeParse({ sort: 'price; drop table' }).success).toBe(false);
    expect(productQuerySchema.parse({}).limit).toBe(24);
  });
  it('product PATCH never fills in defaults (would re-activate hidden products)', () => {
    expect(productUpdateSchema.safeParse({}).success).toBe(false);
    expect(productUpdateSchema.parse({ price: 5 })).toEqual({ price: 5 });
    expect(productUpdateSchema.parse({ active: false })).toEqual({ active: false });
  });
  it('promo: percent over 100 and inverted dates are rejected', () => {
    expect(promoCreateSchema.safeParse({ code: 'ABC', type: 'percent', value: 101 }).success).toBe(
      false,
    );
    expect(promoCreateSchema.safeParse({ code: 'a b', type: 'fixed', value: 1 }).success).toBe(
      false,
    );
    expect(
      promoCreateSchema.safeParse({
        code: 'ABC',
        type: 'fixed',
        value: 1,
        startsAt: '2026-02-01T00:00:00Z',
        expiresAt: '2026-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
  });
  it('returns: duplicates and zero quantities are rejected', () => {
    expect(returnCreateSchema.safeParse({ items: [] }).success).toBe(false);
    expect(returnCreateSchema.safeParse({ items: [{ orderItemId: uuid, qty: 0 }] }).success).toBe(
      false,
    );
    expect(
      returnCreateSchema.safeParse({
        items: [
          { orderItemId: uuid, qty: 1 },
          { orderItemId: uuid, qty: 1 },
        ],
      }).success,
    ).toBe(false);
  });
  it('sales report: bounded period', () => {
    expect(salesQuerySchema.safeParse({ from: '2026-01-01', to: '2026-03-31' }).success).toBe(true);
    expect(salesQuerySchema.safeParse({ from: '2026-03-31', to: '2026-01-01' }).success).toBe(
      false,
    );
    expect(salesQuerySchema.safeParse({ from: '2020-01-01', to: '2026-01-01' }).success).toBe(
      false,
    );
    expect(salesQuerySchema.safeParse({ from: '2026-13-45', to: '2026-14-45' }).success).toBe(
      false,
    );
  });
  it('webhook event is a closed union', () => {
    const ok = {
      eventId: uuid,
      type: 'payment.succeeded',
      paymentId: uuid,
      orderId: uuid,
      amount: 100,
      occurredAt: '2026-01-01T00:00:00Z',
    };
    expect(webhookEventSchema.safeParse(ok).success).toBe(true);
    expect(webhookEventSchema.safeParse({ ...ok, type: 'payment.hacked' }).success).toBe(false);
    expect(webhookEventSchema.safeParse({ ...ok, amount: -1 }).success).toBe(false);
    expect(webhookEventSchema.safeParse({ ...ok, type: 'refund.succeeded' }).success).toBe(false); // refundId missing
  });
});

describe('isRealDate / isoDate', () => {
  it('accepts real days (incl. leap days) and refuses days that only match the shape', async () => {
    const { isRealDate, isoDate } = await import('../src');
    for (const ok of ['2024-02-29', '2026-12-31', '2026-01-01', '2000-02-29', '0099-03-04'])
      expect(isRealDate(ok), ok).toBe(true);
    for (const bad of [
      '2026-02-30',
      '2025-02-29',
      '1900-02-29',
      '2026-04-31',
      '2026-00-10',
      '2026-13-01',
      '2026-01-00',
      '2026-1-1',
      '26-01-01',
      '2026-01-01T00:00',
      '',
    ])
      expect(isRealDate(bad), bad).toBe(false);
    expect(isoDate.safeParse('2026-02-30').success).toBe(false);
    expect(isoDate.safeParse('2026-02-28').success).toBe(true);
  });
});
