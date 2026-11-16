import { listOrdersPage } from '@shop/db';
import { type OrderDto, type OrderListQuery, type OrderSummaryDto, type Page } from '@shop/shared';
import { type AppCtx } from '../ctx';
import { decodeCursor, encodeCursor, UUID_RE } from '../http/cursor';
import { notFound } from '../http/errors';
import { type SessionUser } from '../http/types';
import { loadOrderDto, toSummary } from './order-dto';
import { schema } from '@shop/db';
import { eq } from 'drizzle-orm';

const startOfDay = (d: string) => new Date(`${d}T00:00:00.000Z`);
const startOfNextDay = (d: string) => new Date(startOfDay(d).getTime() + 86_400_000);

export async function listOrders(
  ctx: AppCtx,
  user: SessionUser,
  q: OrderListQuery,
): Promise<Page<OrderSummaryDto>> {
  const after = q.cursor
    ? decodeCursor(q.cursor, (v) =>
        typeof v.c === 'string' &&
        !Number.isNaN(Date.parse(v.c)) &&
        typeof v.id === 'string' &&
        UUID_RE.test(v.id)
          ? { c: v.c, id: v.id }
          : null,
      )
    : undefined;
  const isManager = user.role === 'manager';
  const page = await listOrdersPage(ctx.db, {
    userId: isManager ? undefined : user.id,
    status: q.status,
    from: q.from ? startOfDay(q.from) : undefined,
    to: q.to ? startOfNextDay(q.to) : undefined,
    q: isManager ? q.q : undefined,
    limit: q.limit,
    after: after ? { createdAt: new Date(after.c), id: after.id } : undefined,
  });
  const last = page.rows[page.rows.length - 1];
  return {
    items: page.rows.map((r) => toSummary(r, isManager ? r.customerEmail : undefined)),
    nextCursor:
      page.hasMore && last ? encodeCursor({ c: last.createdAt.toISOString(), id: last.id }) : null,
  };
}

/** Customers only ever see their own orders; somebody else's id looks exactly like a missing one. */
export async function getOrderFor(
  ctx: AppCtx,
  user: SessionUser,
  orderId: string,
): Promise<OrderDto> {
  if (user.role === 'customer') {
    const own = await ctx.db
      .select({ userId: schema.orders.userId })
      .from(schema.orders)
      .where(eq(schema.orders.id, orderId))
      .limit(1);
    if (!own[0] || own[0].userId !== user.id) throw notFound('Order not found');
  }
  return loadOrderDto(ctx.db, ctx, orderId, { withEmail: user.role === 'manager' });
}
