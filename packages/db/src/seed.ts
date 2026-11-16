import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  calcReturnRefund,
  calcTotals,
  DEFAULT_MONEY_CONFIG,
  validatePromo,
  type OrderStatus,
  type PromoRecord,
} from '@shop/shared';
import { type Db } from './client';
import { hashPassword } from './password';
import * as t from './schema';

export type SeedOptions = {
  /** "now" of the generated history */
  now?: Date;
  managerPassword: string;
  customerPassword: string;
  products?: number;
  customers?: number;
  orders?: number;
  days?: number;
  /** PRNG seed: same seed => same data (except uuids) */
  seed?: number;
};

export type SeedSummary = {
  categories: number;
  products: number;
  customers: number;
  orders: number;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES: { name: string; nouns: string[] }[] = [
  {
    name: 'Electronics',
    nouns: ['Headphones', 'Charger', 'Speaker', 'Keyboard', 'Mouse', 'Webcam'],
  },
  { name: 'Books', nouns: ['Novel', 'Cookbook', 'Atlas', 'Biography', 'Notebook', 'Dictionary'] },
  { name: 'Clothing', nouns: ['T-shirt', 'Jacket', 'Jeans', 'Hoodie', 'Scarf', 'Socks'] },
  { name: 'Home & Kitchen', nouns: ['Kettle', 'Pan', 'Blender', 'Lamp', 'Towel', 'Mug'] },
  {
    name: 'Sports',
    nouns: ['Yoga Mat', 'Dumbbell', 'Football', 'Bottle', 'Backpack', 'Jump Rope'],
  },
  { name: 'Toys', nouns: ['Puzzle', 'Robot', 'Board Game', 'Doll', 'Blocks', 'Kite'] },
  { name: 'Beauty', nouns: ['Shampoo', 'Cream', 'Perfume', 'Lipstick', 'Soap', 'Mask'] },
  { name: 'Garden', nouns: ['Shovel', 'Hose', 'Planter', 'Seeds', 'Gloves', 'Sprinkler'] },
  { name: 'Automotive', nouns: ['Wiper', 'Car Mat', 'Oil', 'Air Freshener', 'Cable', 'Cover'] },
  { name: 'Grocery', nouns: ['Coffee', 'Tea', 'Pasta', 'Olive Oil', 'Honey', 'Chocolate'] },
];
const ADJECTIVES = [
  'Classic',
  'Pro',
  'Eco',
  'Mini',
  'Ultra',
  'Smart',
  'Premium',
  'Basic',
  'Deluxe',
  'Compact',
];
const FIRST = [
  'Olena',
  'Ivan',
  'Maria',
  'Andriy',
  'Sofia',
  'Taras',
  'Iryna',
  'Bohdan',
  'Kateryna',
  'Oleh',
];
const LAST = [
  'Shevchenko',
  'Kovalenko',
  'Bondarenko',
  'Tkachenko',
  'Kravchenko',
  'Melnyk',
  'Boyko',
  'Lysenko',
];
const CITIES = ['Kyiv', 'Lviv', 'Odesa', 'Dnipro', 'Kharkiv', 'Poltava'];

type PromoSeed = Omit<typeof t.promoCodes.$inferInsert, 'id' | 'createdAt'> &
  Pick<
    PromoRecord,
    | 'type'
    | 'value'
    | 'minOrder'
    | 'startsAt'
    | 'expiresAt'
    | 'maxUses'
    | 'used'
    | 'oncePerCustomer'
    | 'active'
  >;

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function insertChunked<T>(
  rows: T[],
  size: number,
  fn: (c: T[]) => Promise<unknown>,
): Promise<void> {
  for (const c of chunks(rows, size)) await fn(c);
}

/** True when the database already holds users: seeding is skipped so restarts are cheap and safe. */
export async function isSeeded(db: Db): Promise<boolean> {
  const r = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM users`);
  return Number(r.rows[0]?.n ?? 0) > 0;
}

export async function seedDatabase(db: Db, opts: SeedOptions): Promise<SeedSummary> {
  const now = opts.now ?? new Date();
  const rnd = mulberry32(opts.seed ?? 20260101);
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const chance = (p: number) => rnd() < p;

  const productCount = opts.products ?? 500;
  const customerCount = opts.customers ?? 50;
  const orderCount = opts.orders ?? 10_000;
  const days = opts.days ?? 90;
  const awaitingCount = Math.min(10, Math.floor(orderCount / 100));

  const [managerHash, customerHash] = await Promise.all([
    hashPassword(opts.managerPassword),
    hashPassword(opts.customerPassword),
  ]);

  // ---- users
  const manager: typeof t.users.$inferInsert = {
    id: randomUUID(),
    email: 'manager@shop.test',
    name: 'Shop Manager',
    passwordHash: managerHash,
    role: 'manager',
    createdAt: new Date(now.getTime() - (days + 30) * DAY),
  };
  const customers: (typeof t.users.$inferInsert & { id: string })[] = Array.from(
    { length: customerCount },
    (_, i) => ({
      id: randomUUID(),
      email: `customer${i + 1}@shop.test`,
      name: `${pick(FIRST)} ${pick(LAST)}`,
      passwordHash: customerHash,
      role: 'customer' as const,
      createdAt: new Date(now.getTime() - (days + 20) * DAY),
    }),
  );
  await db.insert(t.users).values([manager, ...customers]);

  // ---- categories + products
  const cats = CATEGORIES.map((c) => ({
    id: randomUUID(),
    name: c.name,
    slug: c.name
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
    nouns: c.nouns,
  }));
  await db.insert(t.categories).values(cats.map(({ id, name, slug }) => ({ id, name, slug })));

  type P = {
    id: string;
    name: string;
    price: number;
    stock: number;
    active: boolean;
    categoryId: string;
  };
  const prods: P[] = Array.from({ length: productCount }, (_, i) => {
    const c = cats[i % cats.length]!;
    return {
      id: randomUUID(),
      name: `${pick(ADJECTIVES)} ${pick(c.nouns)} ${100 + i}`,
      categoryId: c.id,
      price: int(10, 25_000) * 100 + pick([0, 0, 0, 50, 90, 99]),
      stock: chance(0.04) ? 0 : int(5, 500),
      active: !chance(0.05),
      createdAt: new Date(now.getTime() - int(0, days) * DAY),
    };
  });
  const activeProducts = prods.filter((p) => p.active);

  // ---- promo codes
  const promoSeeds: PromoSeed[] = [
    {
      code: 'WELCOME10',
      type: 'percent',
      value: 10,
      minOrder: 0,
      startsAt: null,
      expiresAt: null,
      maxUses: null,
      used: 0,
      oncePerCustomer: true,
      active: true,
    },
    {
      code: 'BIG7',
      type: 'percent',
      value: 7,
      minOrder: 300_000,
      startsAt: null,
      expiresAt: null,
      maxUses: null,
      used: 0,
      oncePerCustomer: false,
      active: true,
    },
    {
      code: 'SAVE500',
      type: 'fixed',
      value: 50_000,
      minOrder: 400_000,
      startsAt: null,
      expiresAt: null,
      maxUses: null,
      used: 0,
      oncePerCustomer: false,
      active: true,
    },
    // limit 1: handy for demonstrating the concurrent redemption scenario
    {
      code: 'ONLYONE',
      type: 'percent',
      value: 15,
      minOrder: 0,
      startsAt: null,
      expiresAt: null,
      maxUses: 1,
      used: 0,
      oncePerCustomer: true,
      active: true,
    },
    {
      code: 'EXPIRED5',
      type: 'percent',
      value: 5,
      minOrder: 0,
      startsAt: new Date(now.getTime() - 120 * DAY),
      expiresAt: new Date(now.getTime() - 30 * DAY),
      maxUses: null,
      used: 0,
      oncePerCustomer: true,
      active: true,
    },
    {
      code: 'NEXTYEAR',
      type: 'fixed',
      value: 10_000,
      minOrder: 0,
      startsAt: new Date(now.getTime() + 60 * DAY),
      expiresAt: null,
      maxUses: null,
      used: 0,
      oncePerCustomer: true,
      active: true,
    },
  ];
  const promos = promoSeeds.map((p) => ({ ...p, id: randomUUID() as string }));
  const historicalPromos = promos.filter((p) => ['WELCOME10', 'BIG7', 'SAVE500'].includes(p.code));
  const usedByUser = new Map<string, Set<string>>(); // promoId -> userIds (non-cancelled orders only)

  // ---- orders
  const start = now.getTime() - days * DAY;
  const span = days * DAY - 15 * MIN;
  type OrderRow = typeof t.orders.$inferInsert;
  const orderRows: OrderRow[] = [];
  const itemRows: (typeof t.orderItems.$inferInsert)[] = [];
  const eventRows: (typeof t.orderEvents.$inferInsert)[] = [];
  const paymentRows: (typeof t.payments.$inferInsert)[] = [];
  const refundRows: (typeof t.refunds.$inferInsert)[] = [];
  const returnRows: (typeof t.returns.$inferInsert)[] = [];
  const returnItemRows: (typeof t.returnItems.$inferInsert)[] = [];
  const jobRows: (typeof t.jobs.$inferInsert)[] = [];
  const reservedUnits = new Map<string, number>();

  const ev = (orderId: string, type: string, at: Date, data: Record<string, unknown> = {}) =>
    eventRows.push({ id: randomUUID(), orderId, type, data, createdAt: at });

  for (let i = 0; i < orderCount; i++) {
    const awaiting = i >= orderCount - awaitingCount;
    const createdMs = awaiting
      ? now.getTime() - (awaitingCount - (i - (orderCount - awaitingCount))) * MIN
      : Math.floor(start + ((i + rnd()) / (orderCount - awaitingCount)) * span);
    const createdAt = new Date(createdMs);
    const customer = pick(customers);
    const id = randomUUID();

    // lines
    const lineCount = int(1, 5);
    const chosen = new Map<string, P>();
    while (chosen.size < lineCount) {
      const p = pick(activeProducts);
      chosen.set(p.id, p);
    }
    const lines = [...chosen.values()].map((p) => ({ p, qty: int(1, 4) }));
    const deliveryMethod = chance(0.6) ? ('courier' as const) : ('pickup' as const);

    // target status + timeline
    let status: OrderStatus;
    let cancelReason: 'customer' | 'expired' | null = null;
    let paidAfterCancel = false;
    if (awaiting) status = 'awaiting_payment';
    else {
      const r = rnd();
      if (r < 0.46) status = 'delivered';
      else if (r < 0.6) status = 'shipped';
      else if (r < 0.72) status = 'paid';
      else {
        status = 'cancelled';
        const c = rnd();
        if (c < 0.45) cancelReason = 'expired';
        else if (c < 0.8) cancelReason = 'customer';
        else {
          cancelReason = 'customer';
          paidAfterCancel = true; // paid, then cancelled by the customer with a full refund
        }
      }
    }
    const paidMs = createdMs + int(1, 30) * MIN;
    const shippedMs = paidMs + int(1, 24) * HOUR;
    const deliveredMs = shippedMs + int(1, 4) * DAY;
    // never let the story run into the future: downgrade the status instead
    if (status === 'delivered' && deliveredMs > now.getTime()) status = 'shipped';
    if (status === 'shipped' && shippedMs > now.getTime()) status = 'paid';
    if (status === 'paid' && paidMs > now.getTime()) status = 'awaiting_payment';
    if (status === 'cancelled' && paidAfterCancel && paidMs + 2 * HOUR > now.getTime())
      paidAfterCancel = false;

    // promo (only where it is valid; counted only if the order keeps its discount)
    let promo: (typeof promos)[number] | null = null;
    let totals = calcTotals({
      lines: lines.map((l) => ({ unitPrice: l.p.price, qty: l.qty })),
      promo: null,
      deliveryMethod,
      config: DEFAULT_MONEY_CONFIG,
    });
    if (chance(0.15)) {
      const cand = pick(historicalPromos);
      const rec: PromoRecord = { ...cand, used: 0, maxUses: cand.maxUses ?? null };
      const check = validatePromo(rec, {
        now: createdAt,
        subtotal: totals.subtotal,
        customerAlreadyUsed: usedByUser.get(cand.id)?.has(customer.id) ?? false,
      });
      if (check.ok) {
        promo = cand;
        totals = calcTotals({
          lines: lines.map((l) => ({ unitPrice: l.p.price, qty: l.qty })),
          promo: { type: cand.type, value: cand.value },
          deliveryMethod,
          config: DEFAULT_MONEY_CONFIG,
        });
      }
    }
    const keepsPromo =
      promo !== null && status !== 'cancelled' && status !== 'awaiting_payment'
        ? true
        : promo !== null && status === 'awaiting_payment';
    if (promo && keepsPromo) {
      const s = usedByUser.get(promo.id) ?? new Set<string>();
      s.add(customer.id);
      usedByUser.set(promo.id, s);
      promo.used += 1;
    }

    const paidAt =
      status !== 'awaiting_payment' && (status !== 'cancelled' || paidAfterCancel)
        ? new Date(paidMs)
        : null;
    const cancelledAt =
      status === 'cancelled'
        ? new Date(
            paidAfterCancel
              ? paidMs + int(1, 120) * MIN
              : createdMs + (cancelReason === 'expired' ? 15 * MIN : int(1, 14) * MIN),
          )
        : null;
    const shippedAt = status === 'shipped' || status === 'delivered' ? new Date(shippedMs) : null;
    const deliveredAt = status === 'delivered' ? new Date(deliveredMs) : null;
    const reservedUntil = status === 'awaiting_payment' ? new Date(createdMs + 15 * MIN) : null;

    // returns for some delivered orders (inside the 14-day window)
    let refunded = paidAfterCancel ? totals.total : 0;
    let returnPlan: { orderItemIdx: number; qty: number }[] = [];
    if (status === 'delivered' && chance(0.12)) {
      const idx = int(0, lines.length - 1);
      returnPlan = [{ orderItemIdx: idx, qty: int(1, lines[idx]!.qty) }];
    }
    const orderItemIds = lines.map(() => randomUUID());
    const orderNumber = 10_234 + i;

    const addrOk = deliveryMethod === 'courier';
    orderRows.push({
      id,
      number: orderNumber,
      userId: customer.id,
      idempotencyKey: randomUUID(),
      status,
      cancelReason,
      deliveryMethod,
      address: addrOk
        ? {
            fullName: customer.name,
            phone: '+380501234567',
            city: pick(CITIES),
            street: 'Khreshchatyk',
            building: String(int(1, 99)),
            apartment: String(int(1, 150)),
            postalCode: String(int(10000, 99999)),
          }
        : null,
      promoId: promo?.id ?? null,
      promoCode: promo?.code ?? null,
      subtotal: totals.subtotal,
      discount: totals.discount,
      delivery: totals.delivery,
      total: totals.total,
      refundedTotal: 0, // filled below
      reservedUntil,
      createdAt,
      paidAt,
      shippedAt,
      deliveredAt,
      cancelledAt,
    });
    lines.forEach((l, k) =>
      itemRows.push({
        id: orderItemIds[k]!,
        orderId: id,
        productId: l.p.id,
        name: l.p.name,
        qty: l.qty,
        unitPrice: l.p.price,
        discountShare: totals.lines[k]!.discountShare,
        returnedQty: 0,
      }),
    );

    ev(id, 'created', createdAt, { total: totals.total });
    let paymentId: string | null = null;
    if (paidAt) {
      paymentId = randomUUID();
      paymentRows.push({
        id: paymentId,
        orderId: id,
        amount: totals.total,
        status: 'succeeded',
        createdAt,
        completedAt: paidAt,
      });
      ev(id, 'paid', paidAt, { amount: totals.total });
    }
    if (status === 'awaiting_payment') {
      lines.forEach((l) => reservedUnits.set(l.p.id, (reservedUnits.get(l.p.id) ?? 0) + l.qty));
      jobRows.push({
        type: 'expire_order',
        payload: { orderId: id },
        runAt: reservedUntil!,
        state: 'pending',
      });
    }
    if (shippedAt) ev(id, 'shipped', shippedAt);
    if (deliveredAt) ev(id, 'delivered', deliveredAt);
    if (status === 'cancelled') {
      if (cancelReason === 'expired') ev(id, 'expired', cancelledAt!);
      else ev(id, 'cancelled', cancelledAt!, { by: 'customer' });
      if (paidAfterCancel && paymentId) {
        const refundId = randomUUID();
        refundRows.push({
          id: refundId,
          orderId: id,
          paymentId,
          amount: totals.total,
          kind: 'cancellation',
          status: 'succeeded',
          createdAt: cancelledAt!,
          completedAt: new Date(cancelledAt!.getTime() + 5_000),
        });
        ev(id, 'refund_requested', cancelledAt!, { amount: totals.total });
        ev(id, 'refund_succeeded', new Date(cancelledAt!.getTime() + 5_000), {
          amount: totals.total,
        });
      }
    }
    if (returnPlan.length > 0 && paymentId && deliveredAt) {
      const retAt = new Date(
        Math.min(now.getTime() - MIN, deliveredAt.getTime() + int(1, 10) * DAY),
      );
      if (retAt > deliveredAt) {
        const returnId = randomUUID();
        const calc = calcReturnRefund(
          returnPlan.map((r) => ({
            net: totals.lines[r.orderItemIdx]!.net,
            qty: lines[r.orderItemIdx]!.qty,
            alreadyReturned: 0,
            returning: r.qty,
          })),
        );
        returnRows.push({
          id: returnId,
          orderId: id,
          reason: 'Did not fit',
          amount: calc.total,
          createdAt: retAt,
        });
        returnPlan.forEach((r, k) => {
          itemRows.find((x) => x.id === orderItemIds[r.orderItemIdx])!.returnedQty = r.qty;
          returnItemRows.push({
            returnId,
            orderItemId: orderItemIds[r.orderItemIdx]!,
            qty: r.qty,
            amount: calc.perLine[k]!,
          });
        });
        if (calc.total > 0) {
          refundRows.push({
            id: randomUUID(),
            orderId: id,
            paymentId,
            returnId,
            amount: calc.total,
            kind: 'return',
            status: 'succeeded',
            createdAt: retAt,
            completedAt: new Date(retAt.getTime() + 5_000),
          });
          refunded += calc.total;
        }
        ev(id, 'return_requested', retAt, { amount: calc.total });
        if (calc.total > 0)
          ev(id, 'refund_succeeded', new Date(retAt.getTime() + 5_000), { amount: calc.total });
      }
    }
    orderRows[orderRows.length - 1]!.refundedTotal = refunded;
  }

  // ---- write everything
  await insertChunked(prods, 1000, (c) =>
    db.insert(t.products).values(c.map((p) => ({ ...p, stock: p.stock }))),
  );
  // reserved units of the "awaiting payment" orders are already out of the sellable stock
  for (const [productId, qty] of reservedUnits) {
    await db.execute(
      sql`UPDATE products SET stock = greatest(stock - ${qty}, 0) WHERE id = ${productId}`,
    );
  }
  await db.insert(t.promoCodes).values(promos);
  await insertChunked(orderRows, 500, (c) => db.insert(t.orders).values(c));
  await insertChunked(itemRows, 1000, (c) => db.insert(t.orderItems).values(c));
  await insertChunked(eventRows, 2000, (c) => db.insert(t.orderEvents).values(c));
  await insertChunked(paymentRows, 1000, (c) => db.insert(t.payments).values(c));
  await insertChunked(returnRows, 1000, (c) => db.insert(t.returns).values(c));
  await insertChunked(returnItemRows, 1000, (c) => db.insert(t.returnItems).values(c));
  await insertChunked(refundRows, 1000, (c) => db.insert(t.refunds).values(c));
  const redemptions = orderRows
    .filter((o) => o.promoId && o.status !== 'cancelled')
    .map((o) => ({
      promoId: o.promoId!,
      userId: o.userId,
      orderId: o.id!,
      oncePerCustomer: promos.find((p) => p.id === o.promoId)!.oncePerCustomer,
      createdAt: o.createdAt!,
    }));
  await insertChunked(redemptions, 1000, (c) => db.insert(t.promoRedemptions).values(c));
  for (const p of promos) {
    await db.execute(
      sql`UPDATE promo_codes SET used = ${redemptions.filter((r) => r.promoId === p.id).length} WHERE id = ${p.id}`,
    );
  }
  if (jobRows.length) await db.insert(t.jobs).values(jobRows);
  await db.execute(sql`UPDATE order_counter SET last = ${10_233 + orderCount} WHERE id = 1`);
  await db.execute(sql`ANALYZE`);

  return {
    categories: cats.length,
    products: prods.length,
    customers: customers.length,
    orders: orderCount,
  };
}
