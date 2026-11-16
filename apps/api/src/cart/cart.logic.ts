import { and, eq, sql } from 'drizzle-orm';
import { schema, type Executor } from '@shop/db';
import {
  calcDelivery,
  calcTotals,
  normalizePromoCode,
  validatePromo,
  type CartDto,
  type CartLineDto,
  type PromoCheck,
} from '@shop/shared';
import { moneyConfig, type AppCtx } from '../ctx';
import { notFound, unprocessable } from '../http/errors';
import { customerUsedPromo, findPromoByCode, toPromoRecord } from '../promos/promo-store';

const { carts, cartItems, products } = schema;
export const MAX_CART_LINES = 100;

type CartRow = {
  productId: string;
  name: string;
  qty: number;
  priceSeen: number;
  price: number;
  stock: number;
  active: boolean;
};

export async function loadCartRows(
  ex: Executor,
  userId: string,
): Promise<{ rows: CartRow[]; promoCode: string | null }> {
  const rows = await ex
    .select({
      productId: cartItems.productId,
      name: products.name,
      qty: cartItems.qty,
      priceSeen: cartItems.priceSeen,
      price: products.price,
      stock: products.stock,
      active: products.active,
    })
    .from(cartItems)
    .innerJoin(products, eq(products.id, cartItems.productId))
    .where(eq(cartItems.userId, userId))
    .orderBy(cartItems.addedAt, cartItems.productId);
  const cart = await ex
    .select({ promoCode: carts.promoCode })
    .from(carts)
    .where(eq(carts.userId, userId))
    .limit(1);
  return { rows, promoCode: cart[0]?.promoCode ?? null };
}

export async function evaluatePromo(
  ex: Executor,
  ctx: AppCtx,
  userId: string,
  code: string,
  subtotal: number,
): Promise<PromoCheck> {
  const promo = await findPromoByCode(ex, code);
  if (!promo) return { ok: false, reason: 'not_found' };
  const used = await customerUsedPromo(ex, promo.id, userId);
  return validatePromo(toPromoRecord(promo), {
    now: ctx.clock.now(),
    subtotal,
    customerAlreadyUsed: used,
  });
}

/** The cart the customer sees: current prices, stock problems, promo state, discount shares. */
export async function getCart(ctx: AppCtx, userId: string): Promise<CartDto> {
  const { rows, promoCode } = await loadCartRows(ctx.db, userId);
  const buyable = rows.filter((r) => r.active);
  const subtotalOnly = buyable.reduce((a, r) => a + r.price * r.qty, 0);

  let promoDto: CartDto['promo'] = null;
  let promoRule: { type: 'percent' | 'fixed'; value: number } | null = null;
  if (promoCode) {
    const check = await evaluatePromo(ctx.db, ctx, userId, promoCode, subtotalOnly);
    if (check.ok) {
      const promo = await findPromoByCode(ctx.db, promoCode);
      promoRule = promo ? { type: promo.type, value: promo.value } : null;
      promoDto = {
        code: promoCode,
        valid: true,
        reason: null,
        minOrder: null,
        discount: check.discount,
      };
    } else {
      promoDto = {
        code: promoCode,
        valid: false,
        reason: check.reason,
        minOrder: check.minOrder ?? null,
        discount: 0,
      };
    }
  }

  const cfg = moneyConfig(ctx.env);
  const totals = calcTotals({
    lines: buyable.map((r) => ({ unitPrice: r.price, qty: r.qty })),
    promo: promoRule,
    deliveryMethod: 'pickup',
    config: cfg,
  });
  const byProduct = new Map(buyable.map((r, i) => [r.productId, totals.lines[i]!]));

  const lines: CartLineDto[] = rows.map((r) => {
    const t = byProduct.get(r.productId);
    return {
      productId: r.productId,
      name: r.name,
      qty: r.qty,
      unitPrice: r.price,
      priceSeen: r.priceSeen,
      priceChanged: r.priceSeen !== r.price,
      available: r.active ? r.stock : 0,
      insufficientStock: !r.active || r.stock < r.qty,
      inactive: !r.active,
      subtotal: t?.subtotal ?? 0,
      discountShare: t?.discountShare ?? 0,
      net: t?.net ?? 0,
    };
  });

  return {
    lines,
    promo: promoDto,
    subtotal: totals.subtotal,
    discount: totals.discount,
    afterDiscount: totals.afterDiscount,
    delivery: {
      pickup: 0,
      courier: totals.subtotal === 0 ? 0 : calcDelivery('courier', totals.afterDiscount, cfg),
    },
    hasPriceChanges: lines.some((l) => l.priceChanged),
    hasStockProblems: lines.some((l) => l.insufficientStock),
    reservationMinutes: ctx.env.RESERVATION_MINUTES,
  };
}

async function ensureCart(ex: Executor, userId: string, now: Date): Promise<void> {
  await ex.insert(carts).values({ userId, updatedAt: now }).onConflictDoNothing();
}

export async function putCartItem(
  ctx: AppCtx,
  userId: string,
  productId: string,
  qty: number,
): Promise<CartDto> {
  const rows = await ctx.db
    .select({ price: products.price, active: products.active })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  const p = rows[0];
  if (!p || !p.active) throw notFound('Product not found');
  await ctx.db.transaction(async (tx) => {
    const now = ctx.clock.now();
    await ensureCart(tx, userId, now);
    // serialise cart edits of one customer so the line cap below cannot be raced past
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'cart:' + userId}, 0))`);
    const existing = await tx
      .select({ productId: cartItems.productId })
      .from(cartItems)
      .where(eq(cartItems.userId, userId));
    if (!existing.some((e) => e.productId === productId) && existing.length >= MAX_CART_LINES) {
      throw unprocessable(
        'validation_error',
        `Cart can hold at most ${MAX_CART_LINES} different products`,
      );
    }
    await tx
      .insert(cartItems)
      .values({ userId, productId, qty, priceSeen: p.price, addedAt: now })
      // an existing line keeps the price the customer has seen until they confirm a new one
      .onConflictDoUpdate({ target: [cartItems.userId, cartItems.productId], set: { qty } });
    await tx.update(carts).set({ updatedAt: now }).where(eq(carts.userId, userId));
  });
  return getCart(ctx, userId);
}

export async function removeCartItem(
  ctx: AppCtx,
  userId: string,
  productId: string,
): Promise<CartDto> {
  await ctx.db
    .delete(cartItems)
    .where(and(eq(cartItems.userId, userId), eq(cartItems.productId, productId)));
  return getCart(ctx, userId);
}

/** The customer confirms the new prices shown in the cart. */
export async function acceptPrices(ctx: AppCtx, userId: string): Promise<CartDto> {
  await ctx.db.execute(sql`
    UPDATE cart_items ci SET price_seen = p.price FROM products p
    WHERE p.id = ci.product_id AND ci.user_id = ${userId} AND ci.price_seen <> p.price`);
  return getCart(ctx, userId);
}

export async function applyPromo(ctx: AppCtx, userId: string, code: string): Promise<CartDto> {
  const { rows } = await loadCartRows(ctx.db, userId);
  const subtotal = rows.filter((r) => r.active).reduce((a, r) => a + r.price * r.qty, 0);
  const check = await evaluatePromo(ctx.db, ctx, userId, code, subtotal);
  if (!check.ok) {
    throw unprocessable('promo_rejected', 'Promo code cannot be applied', {
      reason: check.reason,
      minOrder: check.minOrder ?? null,
    });
  }
  await ensureCart(ctx.db, userId, ctx.clock.now());
  await ctx.db
    .update(carts)
    .set({ promoCode: normalizePromoCode(code), updatedAt: ctx.clock.now() })
    .where(eq(carts.userId, userId));
  return getCart(ctx, userId);
}

export async function removePromo(ctx: AppCtx, userId: string): Promise<CartDto> {
  await ctx.db.update(carts).set({ promoCode: null }).where(eq(carts.userId, userId));
  return getCart(ctx, userId);
}
