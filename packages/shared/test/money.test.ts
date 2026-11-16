import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allocateByWeights,
  calcDelivery,
  calcPromoDiscount,
  calcReturnRefund,
  calcTotals,
  cumulativeLineRefund,
  DEFAULT_MONEY_CONFIG as CFG,
} from '../src';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('allocateByWeights', () => {
  it('always sums to the total (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 500_000_000 }),
        fc.array(fc.integer({ min: 0, max: 500_000_000 }), { minLength: 1, maxLength: 30 }),
        (total, weights) => {
          fc.pre(weights.some((w) => w > 0));
          const out = allocateByWeights(total, weights);
          expect(sum(out)).toBe(total);
          out.forEach((v, i) => {
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            if (weights[i] === 0) expect(v).toBe(0);
          });
        },
      ),
      { numRuns: 500 },
    );
  });

  it('is within 1 kopeck of the exact proportional share (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          const out = allocateByWeights(total, weights);
          const W = sum(weights);
          out.forEach((v, i) => expect(Math.abs(v - (total * weights[i]!) / W)).toBeLessThan(1));
        },
      ),
    );
  });

  it('hands the leftover kopecks to the largest remainders, ties to the lower index', () => {
    expect(allocateByWeights(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(allocateByWeights(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(allocateByWeights(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateByWeights(10, [3, 3, 4])).toEqual([3, 3, 4]);
  });

  it('handles edge cases and rejects garbage', () => {
    expect(allocateByWeights(0, [])).toEqual([]);
    expect(allocateByWeights(0, [0, 0])).toEqual([0, 0]);
    expect(() => allocateByWeights(5, [])).toThrow(RangeError);
    expect(() => allocateByWeights(5, [0, 0])).toThrow(RangeError);
    expect(() => allocateByWeights(-1, [1])).toThrow(RangeError);
    expect(() => allocateByWeights(1.5, [1])).toThrow(RangeError);
    expect(() => allocateByWeights(1, [NaN])).toThrow(RangeError);
  });

  it('does not lose precision with huge products (> 2^53)', () => {
    const out = allocateByWeights(999_999_999, [999_999_999, 999_999_999, 1]);
    expect(sum(out)).toBe(999_999_999);
  });
});

describe('promo discount', () => {
  it('percent rounds down, fixed is capped by the subtotal', () => {
    expect(calcPromoDiscount({ type: 'percent', value: 7 }, 1999)).toBe(139); // 139.93
    expect(calcPromoDiscount({ type: 'percent', value: 100 }, 1999)).toBe(1999);
    expect(calcPromoDiscount({ type: 'fixed', value: 50_000 }, 1999)).toBe(1999);
    expect(calcPromoDiscount({ type: 'fixed', value: 500 }, 1999)).toBe(500);
    expect(() => calcPromoDiscount({ type: 'percent', value: 101 }, 10)).toThrow(RangeError);
  });
});

describe('delivery', () => {
  it('pickup is free; courier is 100 ₴ and free from 2000 ₴ AFTER discount', () => {
    expect(calcDelivery('pickup', 1, CFG)).toBe(0);
    expect(calcDelivery('courier', 199_999, CFG)).toBe(10_000);
    expect(calcDelivery('courier', 200_000, CFG)).toBe(0);
  });

  it('threshold uses the discounted amount, not the subtotal', () => {
    const t = calcTotals({
      lines: [{ unitPrice: 210_000, qty: 1 }],
      promo: { type: 'percent', value: 10 }, // 2100 -> 1890 < 2000
      deliveryMethod: 'courier',
      config: CFG,
    });
    expect(t.afterDiscount).toBe(189_000);
    expect(t.delivery).toBe(10_000);
    expect(t.total).toBe(199_000);
  });

  it('empty cart has no delivery fee', () => {
    expect(
      calcTotals({ lines: [], promo: null, deliveryMethod: 'courier', config: CFG }).total,
    ).toBe(0);
  });
});

describe('calcTotals', () => {
  it('7% discount over 3 lines sums to the kopeck (assignment scenario #10)', () => {
    const t = calcTotals({
      lines: [
        { unitPrice: 3333, qty: 1 },
        { unitPrice: 1999, qty: 3 },
        { unitPrice: 12_345, qty: 2 },
      ],
      promo: { type: 'percent', value: 7 },
      deliveryMethod: 'pickup',
      config: CFG,
    });
    expect(t.subtotal).toBe(3333 + 5997 + 24_690);
    expect(t.discount).toBe(Math.floor((t.subtotal * 7) / 100));
    expect(sum(t.lines.map((l) => l.discountShare))).toBe(t.discount);
    expect(sum(t.lines.map((l) => l.net))).toBe(t.afterDiscount);
    expect(t.total).toBe(t.afterDiscount);
  });

  it('lines always add up to the order totals (property)', () => {
    const line = fc.record({
      unitPrice: fc.integer({ min: 1, max: 5_000_000 }),
      qty: fc.integer({ min: 1, max: 50 }),
    });
    const promo = fc.oneof(
      fc.constant(null),
      fc.record({ type: fc.constant('percent' as const), value: fc.integer({ min: 1, max: 100 }) }),
      fc.record({
        type: fc.constant('fixed' as const),
        value: fc.integer({ min: 1, max: 50_000_000 }),
      }),
    );
    fc.assert(
      fc.property(
        fc.array(line, { minLength: 1, maxLength: 15 }),
        promo,
        fc.constantFrom('pickup' as const, 'courier' as const),
        (lines, p, deliveryMethod) => {
          const t = calcTotals({ lines, promo: p, deliveryMethod, config: CFG });
          expect(sum(t.lines.map((l) => l.subtotal))).toBe(t.subtotal);
          expect(sum(t.lines.map((l) => l.discountShare))).toBe(t.discount);
          expect(sum(t.lines.map((l) => l.net))).toBe(t.afterDiscount);
          expect(t.total).toBe(t.afterDiscount + t.delivery);
          t.lines.forEach((l) => {
            expect(l.net).toBeGreaterThanOrEqual(0);
            expect(l.discountShare).toBeLessThanOrEqual(l.subtotal);
          });
        },
      ),
      { numRuns: 500 },
    );
  });

  it('rejects invalid input instead of producing NaN', () => {
    expect(() =>
      calcTotals({
        lines: [{ unitPrice: 10, qty: 0 }],
        promo: null,
        deliveryMethod: 'pickup',
        config: CFG,
      }),
    ).toThrow(RangeError);
    expect(() =>
      calcTotals({
        lines: [{ unitPrice: -1, qty: 1 }],
        promo: null,
        deliveryMethod: 'pickup',
        config: CFG,
      }),
    ).toThrow(RangeError);
  });
});

describe('refunds', () => {
  it('refund of one line includes only its discount share, never delivery', () => {
    const t = calcTotals({
      lines: [
        { unitPrice: 10_000, qty: 1 },
        { unitPrice: 10_000, qty: 1 },
        { unitPrice: 10_000, qty: 1 },
      ],
      promo: { type: 'percent', value: 7 },
      deliveryMethod: 'courier',
      config: CFG,
    });
    // 30000 - 2100 = 27900 after discount (< 200000, so delivery is charged)
    expect(t.delivery).toBe(10_000);
    const r = calcReturnRefund([
      { net: t.lines[0]!.net, qty: 1, alreadyReturned: 0, returning: 1 },
    ]);
    expect(r.total).toBe(t.lines[0]!.net);
    expect(r.total).toBe(9300);
  });

  it('partial returns of one line add up to exactly the line net (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 1, max: 40 }),
        fc.infiniteStream(fc.integer({ min: 1, max: 5 })),
        (net, qty, stream) => {
          let returned = 0;
          let refunded = 0;
          const it = stream[Symbol.iterator]();
          while (returned < qty) {
            const step = Math.min(it.next().value as number, qty - returned);
            refunded += calcReturnRefund([
              { net, qty, alreadyReturned: returned, returning: step },
            ]).total;
            returned += step;
          }
          expect(refunded).toBe(net);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('cumulative refund is monotonic and bounded', () => {
    for (let k = 0; k <= 7; k++) {
      expect(cumulativeLineRefund(100, 7, k)).toBeLessThanOrEqual(100);
      if (k > 0) {
        expect(cumulativeLineRefund(100, 7, k)).toBeGreaterThanOrEqual(
          cumulativeLineRefund(100, 7, k - 1),
        );
      }
    }
    expect(cumulativeLineRefund(100, 7, 7)).toBe(100);
  });

  it('refuses to return more than was bought', () => {
    expect(() =>
      calcReturnRefund([{ net: 100, qty: 2, alreadyReturned: 2, returning: 1 }]),
    ).toThrow(RangeError);
    expect(() =>
      calcReturnRefund([{ net: 100, qty: 2, alreadyReturned: 0, returning: 0 }]),
    ).toThrow(RangeError);
    expect(() =>
      calcReturnRefund([{ net: 100, qty: 2, alreadyReturned: 1, returning: 2 }]),
    ).toThrow(RangeError);
  });
});
