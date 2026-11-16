import { eq, sql } from 'drizzle-orm';
import { releaseStock, schema, type Tx } from '@shop/db';
import {
  calcReturnRefund,
  nextManagerStatus,
  type OrderDto,
  type ReturnCreate,
} from '@shop/shared';
import { type AppCtx } from '../ctx';
import { AppError, conflict, notFound, unprocessable } from '../http/errors';
import { releasePromo } from '../promos/promo-store';
import { loadOrderDto } from './order-dto';
import {
  addEvent,
  createRefund,
  findSucceededPayment,
  lockOrder,
  type OrderRow,
} from './order-support';

const { orders, orderItems, returns, returnItems } = schema;

async function restockOrder(tx: Tx, orderId: string): Promise<void> {
  const items = await tx
    .select({ productId: orderItems.productId, qty: orderItems.qty })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  await releaseStock(tx, items);
}

/**
 * Cancels an order that has NOT been cancelled yet and gives back everything it held:
 * stock, the promo use, and (when it was paid) the money, via the payment stub.
 * Caller holds the order row lock.
 */
export async function cancelLockedOrder(
  tx: Tx,
  ctx: AppCtx,
  order: OrderRow,
  reason: 'customer' | 'expired' | 'manager',
): Promise<void> {
  const now = ctx.clock.now();
  const wasPaid = order.status === 'paid';
  await tx
    .update(orders)
    .set({ status: 'cancelled', cancelReason: reason, cancelledAt: now, reservedUntil: null })
    .where(eq(orders.id, order.id));
  await restockOrder(tx, order.id);
  await releasePromo(tx, order.id);
  await addEvent(tx, order.id, reason === 'expired' ? 'expired' : 'cancelled', now, { by: reason });
  if (wasPaid) {
    const payment = await findSucceededPayment(tx, order.id);
    if (payment) {
      await createRefund(tx, ctx, {
        order,
        paymentId: payment.id,
        amount: order.total - order.refundedTotal,
        kind: 'cancellation',
      });
    }
  }
}

export async function cancelOrder(ctx: AppCtx, orderId: string, userId: string): Promise<OrderDto> {
  await ctx.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.userId !== userId) throw notFound('Order not found');
    if (order.status === 'cancelled') return; // double click: already done
    if (order.status !== 'awaiting_payment' && order.status !== 'paid') {
      throw new AppError(
        409,
        'invalid_transition',
        `An order that is ${order.status} cannot be cancelled`,
      );
    }
    await cancelLockedOrder(tx, ctx, order, 'customer');
  });
  return loadOrderDto(ctx.db, ctx, orderId);
}

export async function expireOrder(ctx: AppCtx, orderId: string): Promise<'expired' | 'skipped'> {
  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for('update')
      .limit(1);
    const order = rows[0];
    if (!order || order.status !== 'awaiting_payment') return 'skipped';
    if (!order.reservedUntil || order.reservedUntil > ctx.clock.now()) return 'skipped';
    await cancelLockedOrder(tx, ctx, order, 'expired');
    return 'expired';
  });
}

export async function changeStatus(
  ctx: AppCtx,
  orderId: string,
  target: 'shipped' | 'delivered',
): Promise<OrderDto> {
  await ctx.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (nextManagerStatus(order.status) !== target) {
      throw new AppError(
        409,
        'invalid_transition',
        `Cannot move an order from ${order.status} to ${target}`,
      );
    }
    const now = ctx.clock.now();
    await tx
      .update(orders)
      .set(
        target === 'shipped'
          ? { status: 'shipped', shippedAt: now }
          : { status: 'delivered', deliveredAt: now },
      )
      .where(eq(orders.id, orderId));
    await addEvent(tx, orderId, target, now);
  });
  return loadOrderDto(ctx.db, ctx, orderId, { withEmail: true });
}

/**
 * Partial return of a delivered order (within the return window).
 * Refund = what the customer really paid for the returned units (line price minus that line's
 * discount share, cumulative rounding so several returns add up exactly). Delivery is not refunded.
 */
export async function createReturn(
  ctx: AppCtx,
  orderId: string,
  userId: string,
  input: ReturnCreate,
): Promise<OrderDto> {
  await ctx.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.userId !== userId) throw notFound('Order not found');
    if (order.status !== 'delivered' || !order.deliveredAt) {
      throw new AppError(409, 'invalid_transition', 'Only delivered orders can be returned');
    }
    const now = ctx.clock.now();
    const deadline = order.deliveredAt.getTime() + ctx.env.RETURN_WINDOW_DAYS * 86_400_000;
    if (now.getTime() > deadline) {
      throw new AppError(
        409,
        'return_window_closed',
        `The ${ctx.env.RETURN_WINDOW_DAYS}-day return window has closed`,
      );
    }
    const items = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .for('update');
    const byId = new Map(items.map((i) => [i.id, i]));
    const lines = input.items.map((r) => {
      const item = byId.get(r.orderItemId);
      if (!item)
        throw unprocessable('validation_error', 'Unknown order item', [
          { path: 'items', message: `item ${r.orderItemId} is not part of this order` },
        ]);
      if (r.qty > item.qty - item.returnedQty) {
        throw new AppError(
          409,
          'return_exceeds_purchased',
          'You cannot return more than you bought',
          {
            orderItemId: item.id,
            bought: item.qty,
            alreadyReturned: item.returnedQty,
            requested: r.qty,
          },
        );
      }
      return { item, qty: r.qty };
    });
    const calc = calcReturnRefund(
      lines.map((l) => ({
        net: l.item.qty * l.item.unitPrice - l.item.discountShare,
        qty: l.item.qty,
        alreadyReturned: l.item.returnedQty,
        returning: l.qty,
      })),
    );

    const [ret] = await tx
      .insert(returns)
      .values({ orderId, reason: input.reason ?? null, amount: calc.total, createdAt: now })
      .returning({ id: returns.id });
    for (const [i, l] of lines.entries()) {
      await tx
        .update(orderItems)
        .set({ returnedQty: sql`${orderItems.returnedQty} + ${l.qty}` })
        .where(eq(orderItems.id, l.item.id));
      await tx.insert(returnItems).values({
        returnId: ret!.id,
        orderItemId: l.item.id,
        qty: l.qty,
        amount: calc.perLine[i]!,
      });
    }
    await releaseStock(
      tx,
      lines.map((l) => ({ productId: l.item.productId, qty: l.qty })),
    );
    await addEvent(tx, orderId, 'return_requested', now, {
      amount: calc.total,
      items: lines.map((l, i) => ({
        orderItemId: l.item.id,
        name: l.item.name,
        qty: l.qty,
        amount: calc.perLine[i],
      })),
    });
    const payment = await findSucceededPayment(tx, orderId);
    if (!payment) throw conflict('conflict', 'Order has no successful payment to refund');
    await createRefund(tx, ctx, {
      order,
      paymentId: payment.id,
      amount: calc.total,
      kind: 'return',
      returnId: ret!.id,
    });
  });
  return loadOrderDto(ctx.db, ctx, orderId);
}
