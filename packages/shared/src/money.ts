import { type DeliveryMethod, type MoneyConfig } from './constants';

/** All amounts are integer kopecks. */
export type Kopecks = number;

export type PromoDiscountRule = { type: 'percent' | 'fixed'; value: number };

function assertInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(`${what} must be a non-negative integer, got ${n}`);
}

/**
 * Splits `total` across `weights` proportionally, using the largest remainder method.
 * Guarantees: result sums to exactly `total`; each part is floor(share) or floor(share)+1;
 * ties on the remainder go to the lower index (deterministic).
 */
export function allocateByWeights(total: Kopecks, weights: readonly number[]): number[] {
  assertInt(total, 'total');
  weights.forEach((w) => assertInt(w, 'weight'));
  if (weights.length === 0) {
    if (total !== 0) throw new RangeError('cannot allocate a non-zero total to zero weights');
    return [];
  }
  const sumW = weights.reduce((a, b) => a + BigInt(b), 0n);
  if (sumW === 0n) {
    if (total !== 0) throw new RangeError('cannot allocate a non-zero total to zero weights');
    return weights.map(() => 0);
  }
  const T = BigInt(total);
  const shares = weights.map((w) => (T * BigInt(w)) / sumW);
  const rems = weights.map((w) => (T * BigInt(w)) % sumW);
  let leftover = Number(T - shares.reduce((a, b) => a + b, 0n));
  const order = weights
    .map((_, i) => i)
    .sort((a, b) => (rems[a]! === rems[b]! ? a - b : rems[a]! > rems[b]! ? -1 : 1));
  const out = shares.map((s) => Number(s));
  for (const i of order) {
    if (leftover === 0) break;
    // a zero-weight line must never receive a kopeck
    if (weights[i] === 0) continue;
    out[i]! += 1;
    leftover -= 1;
  }
  return out;
}

/** Discount for a given subtotal. Percent is rounded DOWN (store-friendly, deterministic). */
export function calcPromoDiscount(rule: PromoDiscountRule, subtotal: Kopecks): Kopecks {
  assertInt(subtotal, 'subtotal');
  if (rule.type === 'percent') {
    if (rule.value < 0 || rule.value > 100) throw new RangeError('percent must be 0..100');
    return Math.floor((subtotal * rule.value) / 100);
  }
  return Math.min(rule.value, subtotal);
}

/** Courier is free from `freeDeliveryFrom` measured AFTER the discount. */
export function calcDelivery(
  method: DeliveryMethod,
  afterDiscount: Kopecks,
  cfg: MoneyConfig,
): Kopecks {
  if (method === 'pickup') return 0;
  return afterDiscount >= cfg.freeDeliveryFrom ? 0 : cfg.deliveryFee;
}

export type TotalsInputLine = { unitPrice: Kopecks; qty: number };
export type TotalsLine = {
  subtotal: Kopecks;
  /** this line's share of the promo discount */
  discountShare: Kopecks;
  /** subtotal - discountShare: what the customer really pays for the line */
  net: Kopecks;
};
export type Totals = {
  lines: TotalsLine[];
  subtotal: Kopecks;
  discount: Kopecks;
  afterDiscount: Kopecks;
  delivery: Kopecks;
  total: Kopecks;
};

export function calcTotals(input: {
  lines: readonly TotalsInputLine[];
  promo: PromoDiscountRule | null;
  deliveryMethod: DeliveryMethod;
  config: MoneyConfig;
}): Totals {
  const lineSubtotals = input.lines.map((l) => {
    assertInt(l.unitPrice, 'unitPrice');
    if (!Number.isSafeInteger(l.qty) || l.qty < 1) throw new RangeError('qty must be >= 1');
    return l.unitPrice * l.qty;
  });
  const subtotal = lineSubtotals.reduce((a, b) => a + b, 0);
  const discount = input.promo ? calcPromoDiscount(input.promo, subtotal) : 0;
  const shares = allocateByWeights(discount, lineSubtotals);
  const lines = lineSubtotals.map((s, i) => ({
    subtotal: s,
    discountShare: shares[i]!,
    net: s - shares[i]!,
  }));
  const afterDiscount = subtotal - discount;
  const delivery =
    subtotal === 0 ? 0 : calcDelivery(input.deliveryMethod, afterDiscount, input.config);
  return { lines, subtotal, discount, afterDiscount, delivery, total: afterDiscount + delivery };
}

/**
 * Cumulative refund for returning `k` of `qty` units of a line whose net value is `net`.
 * floor(net*k/qty); the whole `net` when everything is returned. Using a cumulative
 * function makes repeated partial returns add up to exactly `net` (no lost / extra kopecks).
 */
export function cumulativeLineRefund(net: Kopecks, qty: number, k: number): Kopecks {
  assertInt(net, 'net');
  if (!Number.isSafeInteger(qty) || qty < 1) throw new RangeError('qty must be >= 1');
  if (!Number.isSafeInteger(k) || k < 0 || k > qty)
    throw new RangeError('returned units out of range');
  if (k === qty) return net;
  return Number((BigInt(net) * BigInt(k)) / BigInt(qty));
}

export type ReturnLineInput = {
  /** net value of the whole purchased line (subtotal - discount share) */
  net: Kopecks;
  /** units bought */
  qty: number;
  /** units returned by previous returns */
  alreadyReturned: number;
  /** units returned now */
  returning: number;
};

/** Refund for the lines being returned now. Delivery is never refunded. */
export function calcReturnRefund(lines: readonly ReturnLineInput[]): {
  perLine: Kopecks[];
  total: Kopecks;
} {
  const perLine = lines.map((l) => {
    if (l.returning < 1) throw new RangeError('returning must be >= 1');
    if (l.alreadyReturned + l.returning > l.qty) throw new RangeError('returning more than bought');
    return (
      cumulativeLineRefund(l.net, l.qty, l.alreadyReturned + l.returning) -
      cumulativeLineRefund(l.net, l.qty, l.alreadyReturned)
    );
  });
  return { perLine, total: perLine.reduce((a, b) => a + b, 0) };
}
