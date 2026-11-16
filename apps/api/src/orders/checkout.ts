import { and, eq, sql } from 'drizzle-orm';
import {
  enqueueJob,
  nextOrderNumber,
  pgConstraint,
  pgErrorCode,
  reserveStock,
  schema,
  type Tx,
} from '@shop/db';
import { calcTotals, type OrderCreate, type OrderDto } from '@shop/shared';
import { moneyConfig, type AppCtx } from '../ctx';
import { AppError, conflict, unprocessable } from '../http/errors';
import { loadCartRows } from '../cart/cart.logic';
import {
  customerUsedPromo,
  findPromoByCode,
  redeemPromo,
  toPromoRecord,
} from '../promos/promo-store';
import { validatePromo } from '@shop/shared';
import { loadOrderDto } from './order-dto';
import { addEvent } from './order-support';

const { orders, orderItems, cartItems, carts } = schema;

/**
 * "Place order" - ONE transaction:
 *   1. per-customer advisory lock (a double click / retry waits, then sees the first result)
 *   2. idempotency: same (customer, key) returns the order that already exists
 *   3. reserve stock (rows locked in id order, guarded decrement) -> all-or-nothing + shortage report
 *   4. confirm prices the customer saw, redeem the promo (lock + guarded counter + unique index)
 *   5. compute totals with the shared money functions, take the next order number (last, to keep the lock short)
 *   6. insert order + lines + event + expiry job, empty the cart
 * Any failure rolls everything back: stock, promo use AND the order number.
 */
export async function createOrder(
  ctx: AppCtx,
  userId: string,
  input: OrderCreate,
  idempotencyKey: string,
): Promise<{ order: OrderDto; created: boolean }> {
  try {
    const result = await ctx.db.transaction((tx) =>
      placeOrder(tx, ctx, userId, input, idempotencyKey),
    );
    return { order: await loadOrderDto(ctx.db, ctx, result.orderId), created: result.created };
  } catch (e) {
    // belt and braces: if a concurrent twin still slipped to the unique index, return its order
    if (pgErrorCode(e) === '23505' && pgConstraint(e) === 'orders_user_idem_uq') {
      const existing = await ctx.db
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.userId, userId), eq(orders.idempotencyKey, idempotencyKey)))
        .limit(1);
      if (existing[0])
        return { order: await loadOrderDto(ctx.db, ctx, existing[0].id), created: false };
    }
    throw e;
  }
}

async function placeOrder(
  tx: Tx,
  ctx: AppCtx,
  userId: string,
  input: OrderCreate,
  key: string,
): Promise<{ orderId: string; created: boolean }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'checkout:' + userId}, 0))`);

  const existing = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.idempotencyKey, key)))
    .limit(1);
  if (existing[0]) return { orderId: existing[0].id, created: false };

  const now = ctx.clock.now();
  const pending = await tx.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM orders WHERE user_id = ${userId} AND status = 'awaiting_payment'`,
  );
  if ((pending.rows[0]?.n ?? 0) >= ctx.env.MAX_PENDING_ORDERS) {
    throw conflict(
      'conflict',
      `You already have ${ctx.env.MAX_PENDING_ORDERS} unpaid orders. Pay or cancel one first.`,
    );
  }

  const { rows: cart, promoCode } = await loadCartRows(tx, userId);
  if (cart.length === 0) throw conflict('cart_empty', 'Your cart is empty');

  const reserved = await reserveStock(
    tx,
    cart.map((r) => ({ productId: r.productId, qty: r.qty })),
  );
  if (!reserved.ok) {
    throw conflict(
      'insufficient_stock',
      'Some products are not available in the requested quantity',
      { shortages: reserved.shortages },
    );
  }

  // prices as of NOW (rows are locked); the customer must have confirmed exactly these
  const changed = cart
    .map((r) => ({ r, price: reserved.products.get(r.productId)!.price }))
    .filter((x) => x.price !== x.r.priceSeen)
    .map((x) => ({
      productId: x.r.productId,
      name: x.r.name,
      oldPrice: x.r.priceSeen,
      newPrice: x.price,
    }));
  if (changed.length > 0)
    throw conflict(
      'price_changed',
      'Prices changed. Please review the cart and confirm the new prices.',
      { changes: changed },
    );

  const lines = cart.map((r) => ({
    productId: r.productId,
    name: r.name,
    qty: r.qty,
    unitPrice: reserved.products.get(r.productId)!.price,
  }));
  const subtotal = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);

  const orderId = crypto.randomUUID();
  let promoRow = null as Awaited<ReturnType<typeof findPromoByCode>>;
  if (promoCode) {
    promoRow = await findPromoByCode(tx, promoCode, { lock: true });
    const check = validatePromo(promoRow ? toPromoRecord(promoRow) : null, {
      now,
      subtotal,
      customerAlreadyUsed: promoRow ? await customerUsedPromo(tx, promoRow.id, userId) : false,
    });
    if (!check.ok || !promoRow) {
      throw conflict('promo_rejected', 'Promo code can no longer be applied', {
        reason: check.ok ? 'not_found' : check.reason,
        minOrder: check.ok ? null : (check.minOrder ?? null),
      });
    }
    // the order row must exist before the redemption row that references it
    // (inserted below); redeemPromo is called after the insert
  }

  const totals = calcTotals({
    lines: lines.map((l) => ({ unitPrice: l.unitPrice, qty: l.qty })),
    promo: promoRow ? { type: promoRow.type, value: promoRow.value } : null,
    deliveryMethod: input.deliveryMethod,
    config: moneyConfig(ctx.env),
  });
  if (totals.total <= 0) {
    // a payment of 0 cannot exist; refusing keeps every order payable and every refund meaningful
    throw unprocessable('validation_error', 'The order total must be greater than zero', [
      { path: 'promo', message: 'discount covers the whole order' },
    ]);
  }
  if (input.expectedTotal !== undefined && input.expectedTotal !== totals.total) {
    throw new AppError(
      409,
      'total_mismatch',
      'The total changed. Please review it and try again.',
      { expected: input.expectedTotal, actual: totals.total },
    );
  }

  const number = await nextOrderNumber(tx); // keep last: this row lock serialises order creators
  const reservedUntil = new Date(now.getTime() + ctx.env.RESERVATION_MINUTES * 60_000);
  await tx.insert(orders).values({
    id: orderId,
    number,
    userId,
    idempotencyKey: key,
    status: 'awaiting_payment',
    deliveryMethod: input.deliveryMethod,
    address: input.deliveryMethod === 'courier' ? input.address : null,
    promoId: promoRow?.id ?? null,
    promoCode: promoRow?.code ?? null,
    subtotal: totals.subtotal,
    discount: totals.discount,
    delivery: totals.delivery,
    total: totals.total,
    reservedUntil,
    createdAt: now,
  });
  await tx.insert(orderItems).values(
    lines.map((l, i) => ({
      orderId,
      productId: l.productId,
      name: l.name,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discountShare: totals.lines[i]!.discountShare,
    })),
  );
  if (promoRow) {
    const ok = await redeemPromo(tx, promoRow, userId, orderId, now);
    if (!ok)
      throw conflict('promo_rejected', 'Promo code usage limit reached', {
        reason: 'limit_reached',
        minOrder: null,
      });
  }
  await addEvent(tx, orderId, 'created', now, {
    total: totals.total,
    reservedUntil: reservedUntil.toISOString(),
  });
  await enqueueJob(tx, { type: 'expire_order', payload: { orderId }, runAt: reservedUntil });
  await tx.delete(cartItems).where(eq(cartItems.userId, userId));
  await tx.update(carts).set({ promoCode: null, updatedAt: now }).where(eq(carts.userId, userId));
  return { orderId, created: true };
}
