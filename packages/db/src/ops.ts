import { and, eq, inArray, sql } from 'drizzle-orm';
import { type Executor } from './client';
import { jobs, orderCounter, products, rateLimits } from './schema';

/* ------------------------------------------------------------------ order numbers */

/**
 * Next order number (10234, 10235, ...). Must be called INSIDE the transaction that inserts the
 * order, as late as possible: the UPDATE takes a row lock that serialises order creators until
 * commit, and a rollback undoes the increment, so numbers never have gaps or duplicates.
 */
export async function nextOrderNumber(ex: Executor): Promise<number> {
  const rows = await ex
    .update(orderCounter)
    .set({ last: sql`${orderCounter.last} + 1` })
    .where(eq(orderCounter.id, 1))
    .returning({ last: orderCounter.last });
  const row = rows[0];
  if (!row) throw new Error('order_counter row is missing (migrations not applied?)');
  return row.last;
}

/* ------------------------------------------------------------------ stock */

export type StockItem = { productId: string; qty: number };
export type StockShortage = {
  productId: string;
  name: string;
  requested: number;
  available: number;
};
export type ReservedProduct = { id: string; name: string; price: number; stock: number };
export type ReserveResult =
  { ok: true; products: Map<string, ReservedProduct> } | { ok: false; shortages: StockShortage[] };

function mergeItems(items: readonly StockItem[]): StockItem[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.productId, (m.get(i.productId) ?? 0) + i.qty);
  return [...m.entries()]
    .map(([productId, qty]) => ({ productId, qty }))
    .sort((a, b) => (a.productId < b.productId ? -1 : 1));
}

/**
 * Atomically takes `qty` of every item out of the sellable stock, or takes nothing.
 * Rows are locked in id order (no deadlocks between concurrent multi-item orders), and the
 * decrement itself is guarded (`stock >= qty`) on top of the table CHECK, so stock can't go negative.
 * Inactive or missing products count as 0 available.
 */
export async function reserveStock(
  ex: Executor,
  items: readonly StockItem[],
): Promise<ReserveResult> {
  const merged = mergeItems(items);
  if (merged.length === 0) return { ok: true, products: new Map() };
  const rows = await ex
    .select({
      id: products.id,
      name: products.name,
      price: products.price,
      stock: products.stock,
      active: products.active,
    })
    .from(products)
    .where(
      inArray(
        products.id,
        merged.map((i) => i.productId),
      ),
    )
    .orderBy(products.id)
    .for('update');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const shortages: StockShortage[] = [];
  for (const item of merged) {
    const p = byId.get(item.productId);
    const available = p && p.active ? p.stock : 0;
    if (!p || available < item.qty) {
      shortages.push({
        productId: item.productId,
        name: p?.name ?? '',
        requested: item.qty,
        available,
      });
    }
  }
  if (shortages.length > 0) return { ok: false, shortages };
  for (const item of merged) {
    const updated = await ex
      .update(products)
      .set({ stock: sql`${products.stock} - ${item.qty}` })
      .where(and(eq(products.id, item.productId), sql`${products.stock} >= ${item.qty}`))
      .returning({ id: products.id });
    if (updated.length !== 1)
      throw new Error('stock guard failed after lock (should be impossible)');
  }
  return {
    ok: true,
    products: new Map(
      rows.map((r) => [r.id, { id: r.id, name: r.name, price: r.price, stock: r.stock }]),
    ),
  };
}

/** Puts units back on the shelf (cancellation, expiry, return). */
export async function releaseStock(ex: Executor, items: readonly StockItem[]): Promise<void> {
  for (const item of mergeItems(items)) {
    await ex
      .update(products)
      .set({ stock: sql`${products.stock} + ${item.qty}` })
      .where(eq(products.id, item.productId));
  }
}

/* ------------------------------------------------------------------ rate limit counters */

export function windowStartFor(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** Atomically increments a fixed-window counter and returns the NEW value. */
export async function hitRateLimit(ex: Executor, key: string, windowStart: Date): Promise<number> {
  const rows = await ex
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });
  return rows[0]?.count ?? 0;
}

/** Gives one hit back (e.g. a successful login does not count as a failure). Never below zero. */
export async function undoRateLimitHit(
  ex: Executor,
  key: string,
  windowStart: Date,
): Promise<void> {
  await ex
    .update(rateLimits)
    .set({ count: sql`greatest(${rateLimits.count} - 1, 0)` })
    .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, windowStart)));
}

export async function resetRateLimit(ex: Executor, key: string): Promise<void> {
  await ex.delete(rateLimits).where(eq(rateLimits.key, key));
}

export async function purgeRateLimits(ex: Executor, olderThan: Date): Promise<number> {
  const r = await ex
    .delete(rateLimits)
    .where(sql`${rateLimits.windowStart} < ${olderThan}`)
    .returning({ key: rateLimits.key });
  return r.length;
}

/* ------------------------------------------------------------------ job queue */

export type JobRow = { id: number; type: string; payload: unknown; attempts: number; runAt: Date };

export async function enqueueJob(
  ex: Executor,
  job: { type: string; payload: unknown; runAt: Date },
): Promise<number> {
  const rows = await ex
    .insert(jobs)
    .values({ type: job.type, payload: job.payload ?? {}, runAt: job.runAt })
    .returning({ id: jobs.id });
  const row = rows[0];
  if (!row) throw new Error('enqueueJob failed');
  return row.id;
}

/**
 * Claims up to `limit` due jobs. FOR UPDATE SKIP LOCKED lets any number of workers poll the same
 * table without ever receiving the same job twice. A job stuck in `running` longer than
 * `staleAfterSeconds` (worker crashed) is handed out again.
 */
export async function claimJobs(
  ex: Executor,
  opts: { now: Date; limit: number; staleAfterSeconds?: number },
): Promise<JobRow[]> {
  const stale = new Date(opts.now.getTime() - (opts.staleAfterSeconds ?? 120) * 1000);
  const res = await ex.execute<{
    id: string;
    type: string;
    payload: unknown;
    attempts: number;
    run_at: Date;
  }>(sql`
    UPDATE jobs SET state = 'running', locked_at = ${opts.now}, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM jobs
      WHERE (state = 'pending' AND run_at <= ${opts.now})
         OR (state = 'running' AND locked_at < ${stale})
      ORDER BY run_at, id
      LIMIT ${opts.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, payload, attempts, run_at`);
  return (
    res.rows
      .map((r) => ({
        id: Number(r.id),
        type: r.type,
        payload: r.payload,
        attempts: r.attempts,
        runAt: new Date(r.run_at),
      }))
      // RETURNING does not preserve the sub-select's ORDER BY
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.id - b.id)
  );
}

export async function completeJob(ex: Executor, id: number): Promise<void> {
  await ex.delete(jobs).where(eq(jobs.id, id));
}

/** Retry later (`retryAt`) or give up (`null`, keeps the row with state=failed for inspection). */
export async function failJob(
  ex: Executor,
  id: number,
  error: string,
  retryAt: Date | null,
): Promise<void> {
  await ex
    .update(jobs)
    .set(
      retryAt
        ? { state: 'pending', runAt: retryAt, lockedAt: null, lastError: error.slice(0, 2000) }
        : { state: 'failed', lockedAt: null, lastError: error.slice(0, 2000) },
    )
    .where(eq(jobs.id, id));
}
