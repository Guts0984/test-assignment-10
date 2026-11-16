import { and, desc, eq, gte, ilike, lt, sql, type SQL } from 'drizzle-orm';
import { type Executor } from './client';
import { orders, users } from './schema';

/* ------------------------------------------------------------------ orders list (manager and customer) */

export type OrderListFilter = {
  userId?: string;
  status?: (typeof orders.$inferSelect)['status'];
  /** inclusive lower bound on created_at */
  from?: Date;
  /** exclusive upper bound on created_at */
  to?: Date;
  /** order number ("10234", "ORD-10234") or customer e-mail prefix */
  q?: string;
  limit: number;
  after?: { createdAt: Date; id: string };
};

export type OrderListRow = {
  id: string;
  number: number;
  status: (typeof orders.$inferSelect)['status'];
  total: number;
  refundedTotal: number;
  deliveryMethod: (typeof orders.$inferSelect)['deliveryMethod'];
  createdAt: Date;
  customerEmail: string;
};

/** Keyset pagination on (created_at DESC, id DESC); returns up to `limit` rows + `hasMore`. */
export async function listOrdersPage(
  ex: Executor,
  f: OrderListFilter,
): Promise<{ rows: OrderListRow[]; hasMore: boolean }> {
  const conds: SQL[] = [];
  if (f.userId) conds.push(eq(orders.userId, f.userId));
  if (f.status) conds.push(eq(orders.status, f.status));
  if (f.from) conds.push(gte(orders.createdAt, f.from));
  if (f.to) conds.push(lt(orders.createdAt, f.to));
  if (f.q) {
    const m = /^(?:ord-)?(\d{1,9})$/i.exec(f.q.trim());
    if (m) conds.push(eq(orders.number, Number(m[1])));
    else conds.push(ilike(users.email, `${f.q.trim().replace(/[\\%_]/g, '\\$&')}%`));
  }
  if (f.after) {
    conds.push(
      sql`(${orders.createdAt}, ${orders.id}) < (${f.after.createdAt}, ${f.after.id}::uuid)`,
    );
  }
  const rows = await ex
    .select({
      id: orders.id,
      number: orders.number,
      status: orders.status,
      total: orders.total,
      refundedTotal: orders.refundedTotal,
      deliveryMethod: orders.deliveryMethod,
      createdAt: orders.createdAt,
      customerEmail: users.email,
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.userId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(f.limit + 1);
  return { rows: rows.slice(0, f.limit), hasMore: rows.length > f.limit };
}

/* ------------------------------------------------------------------ sales report */

export type SalesReportRow = {
  netRevenue: number;
  orders: number;
  topProducts: { productId: string; name: string; units: number; revenue: number }[];
  byDay: { day: string; revenue: number; orders: number }[];
};

/**
 * Orders that currently count as sales: paid, shipped or delivered, with paid_at inside
 * [from, to). Net revenue = total - refunded_total (partial returns reduce it; orders cancelled
 * after payment are fully refunded and excluded). Everything is computed in 3 indexed queries.
 */
export async function salesReport(ex: Executor, from: Date, to: Date): Promise<SalesReportRow> {
  const totals = await ex.execute<{ revenue: string; orders: string }>(sql`
    SELECT coalesce(sum(total - refunded_total), 0)::bigint AS revenue, count(*)::bigint AS orders
    FROM orders
    WHERE paid_at >= ${from} AND paid_at < ${to} AND status IN ('paid','shipped','delivered')`);
  const byDay = await ex.execute<{ day: string; revenue: string; orders: string }>(sql`
    SELECT to_char(date_trunc('day', paid_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
           sum(total - refunded_total)::bigint AS revenue, count(*)::bigint AS orders
    FROM orders
    WHERE paid_at >= ${from} AND paid_at < ${to} AND status IN ('paid','shipped','delivered')
    GROUP BY 1 ORDER BY 1`);
  // line net = qty*price - discount share; the returned part is floor(net*returned/qty) (see shared/money)
  const top = await ex.execute<{
    product_id: string;
    name: string;
    units: string;
    revenue: string;
  }>(sql`
    SELECT i.product_id, max(i.name) AS name,
           sum(i.qty - i.returned_qty)::bigint AS units,
           sum(CASE WHEN i.returned_qty = i.qty THEN 0
                    ELSE (i.qty::bigint * i.unit_price - i.discount_share)
                       - ((i.qty::bigint * i.unit_price - i.discount_share) * i.returned_qty) / i.qty END)::bigint AS revenue
    FROM orders o JOIN order_items i ON i.order_id = o.id
    WHERE o.paid_at >= ${from} AND o.paid_at < ${to} AND o.status IN ('paid','shipped','delivered')
    GROUP BY i.product_id
    HAVING sum(i.qty - i.returned_qty) > 0
    ORDER BY units DESC, revenue DESC, i.product_id
    LIMIT 10`);
  const t = totals.rows[0];
  return {
    netRevenue: Number(t?.revenue ?? 0),
    orders: Number(t?.orders ?? 0),
    byDay: byDay.rows.map((r) => ({
      day: r.day,
      revenue: Number(r.revenue),
      orders: Number(r.orders),
    })),
    topProducts: top.rows.map((r) => ({
      productId: r.product_id,
      name: r.name,
      units: Number(r.units),
      revenue: Number(r.revenue),
    })),
  };
}
