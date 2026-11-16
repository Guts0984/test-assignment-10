import { asc, eq, sql } from 'drizzle-orm';
import { schema, type Executor } from '@shop/db';
import { addressSchema, type OrderDto, type OrderSummaryDto } from '@shop/shared';
import { type AppCtx } from '../ctx';
import { notFound } from '../http/errors';
import { formatOrderNumber, type OrderRow } from './order-support';

const { orders, orderItems, orderEvents, refunds, payments, users } = schema;

export function toSummary(
  o: {
    id: string;
    number: number;
    status: OrderRow['status'];
    total: number;
    refundedTotal: number;
    deliveryMethod: OrderRow['deliveryMethod'];
    createdAt: Date;
  },
  customerEmail?: string,
): OrderSummaryDto {
  return {
    id: o.id,
    number: formatOrderNumber(o.number),
    status: o.status,
    total: o.total,
    refundedTotal: o.refundedTotal,
    deliveryMethod: o.deliveryMethod,
    createdAt: o.createdAt.toISOString(),
    ...(customerEmail ? { customerEmail } : {}),
  };
}

export async function loadOrderDto(
  ex: Executor,
  ctx: AppCtx,
  orderId: string,
  opts: { withEmail?: boolean } = {},
): Promise<OrderDto> {
  const rows = await ex
    .select({ o: orders, email: users.email })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('Order not found');
  const o = row.o;
  const [items, events, refundRows, pending] = await Promise.all([
    ex
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.name), asc(orderItems.id)),
    ex
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, orderId))
      .orderBy(asc(orderEvents.seq)),
    ex.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(asc(refunds.seq)),
    ex
      .select({ n: sql<number>`count(*)::int` })
      .from(payments)
      .where(sql`${payments.orderId} = ${orderId} AND ${payments.status} = 'pending'`),
  ]);
  const address = addressSchema.safeParse(o.address);
  const returnableUntil =
    o.status === 'delivered' && o.deliveredAt
      ? new Date(o.deliveredAt.getTime() + ctx.env.RETURN_WINDOW_DAYS * 86_400_000).toISOString()
      : null;
  return {
    ...toSummary(o, opts.withEmail ? row.email : undefined),
    subtotal: o.subtotal,
    discount: o.discount,
    delivery: o.delivery,
    promoCode: o.promoCode,
    address: address.success ? address.data : null,
    reservedUntil: o.reservedUntil?.toISOString() ?? null,
    cancelReason: o.cancelReason,
    paidAt: o.paidAt?.toISOString() ?? null,
    shippedAt: o.shippedAt?.toISOString() ?? null,
    deliveredAt: o.deliveredAt?.toISOString() ?? null,
    pendingPayment: (pending[0]?.n ?? 0) > 0,
    returnableUntil,
    items: items.map((i) => ({
      id: i.id,
      productId: i.productId,
      name: i.name,
      qty: i.qty,
      unitPrice: i.unitPrice,
      discountShare: i.discountShare,
      net: i.qty * i.unitPrice - i.discountShare,
      returnedQty: i.returnedQty,
    })),
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      data: (e.data ?? {}) as Record<string, unknown>,
      createdAt: e.createdAt.toISOString(),
    })),
    refunds: refundRows.map((r) => ({
      id: r.id,
      amount: r.amount,
      kind: r.kind,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
  };
}
