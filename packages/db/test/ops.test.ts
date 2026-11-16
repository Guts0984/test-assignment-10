import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  hitRateLimit,
  nextOrderNumber,
  purgeRateLimits,
  releaseStock,
  reserveStock,
  resetRateLimit,
  undoRateLimitHit,
  windowStartFor,
} from '../src/ops';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import * as t from '../src/schema';
import { mkCategory, mkProduct } from './helpers';

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.drop();
});

const stockOf = async (id: string) =>
  (await tdb.db.select({ s: t.products.stock }).from(t.products).where(eq(t.products.id, id)))[0]!
    .s;

describe('order numbers', () => {
  it('start at 10234 and 60 concurrent creators (a third of them rolling back) leave no gaps or duplicates', async () => {
    const committed: number[] = [];
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        tdb.db
          .transaction(async (tx) => {
            const n = await nextOrderNumber(tx);
            // simulate "something failed after the number was taken"
            if (i % 3 === 0) throw new Error('boom');
            committed.push(n);
          })
          .catch(() => undefined),
      ),
    );
    const sorted = [...committed].sort((a, b) => a - b);
    expect(sorted).toHaveLength(40);
    expect(new Set(sorted).size).toBe(40);
    expect(sorted[0]).toBe(10234);
    // contiguous: a rolled back number is handed out again
    sorted.forEach((n, i) => expect(n).toBe(10234 + i));
    const rows = await tdb.db.select().from(t.orderCounter);
    expect(rows[0]?.last).toBe(10233 + 40);
  });
});

describe('reserveStock', () => {
  it('the last unit goes to exactly one of two concurrent buyers; stock never goes negative', async () => {
    const p = await mkProduct(tdb.db, { stock: 1 });
    const attempt = () =>
      tdb.db.transaction((tx) => reserveStock(tx, [{ productId: p.id, qty: 1 }]));
    const [a, b] = await Promise.all([attempt(), attempt()]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser.ok).toBe(false);
    if (!loser.ok)
      expect(loser.shortages).toEqual([{ productId: p.id, name: 'P', requested: 1, available: 0 }]);
    expect(await stockOf(p.id)).toBe(0);
  });

  it('200 concurrent buyers for 37 units: exactly 37 succeed', async () => {
    const p = await mkProduct(tdb.db, { stock: 37 });
    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        tdb.db.transaction((tx) => reserveStock(tx, [{ productId: p.id, qty: 1 }])),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(37);
    expect(await stockOf(p.id)).toBe(0);
  });

  it('is all-or-nothing and reports every shortage at once', async () => {
    const cat = await mkCategory(tdb.db);
    const a = await mkProduct(tdb.db, { stock: 5, categoryId: cat, name: 'A' });
    const b = await mkProduct(tdb.db, { stock: 1, categoryId: cat, name: 'B' });
    const c = await mkProduct(tdb.db, { stock: 0, categoryId: cat, name: 'C' });
    const r = await tdb.db.transaction((tx) =>
      reserveStock(tx, [
        { productId: a.id, qty: 2 },
        { productId: b.id, qty: 3 },
        { productId: c.id, qty: 1 },
      ]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.shortages.map((s) => [s.name, s.requested, s.available]).sort()).toEqual([
        ['B', 3, 1],
        ['C', 1, 0],
      ]);
    }
    expect(await stockOf(a.id)).toBe(5); // nothing was taken from A
  });

  it('inactive and unknown products count as unavailable; duplicate lines are merged', async () => {
    const inactive = await mkProduct(tdb.db, { stock: 9, active: false });
    const r = await tdb.db.transaction((tx) =>
      reserveStock(tx, [
        { productId: inactive.id, qty: 1 },
        { productId: '00000000-0000-4000-8000-000000000000', qty: 1 },
      ]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.shortages.every((s) => s.available === 0)).toBe(true);

    const p = await mkProduct(tdb.db, { stock: 3 });
    const merged = await tdb.db.transaction((tx) =>
      reserveStock(tx, [
        { productId: p.id, qty: 2 },
        { productId: p.id, qty: 2 },
      ]),
    );
    expect(merged.ok).toBe(false); // 2 + 2 > 3
    expect(await stockOf(p.id)).toBe(3);
  });

  it('opposite item orders in concurrent multi-item reservations do not deadlock', async () => {
    const cat = await mkCategory(tdb.db);
    const a = await mkProduct(tdb.db, { stock: 1000, categoryId: cat });
    const b = await mkProduct(tdb.db, { stock: 1000, categoryId: cat });
    const jobs = Array.from({ length: 100 }, (_, i) =>
      tdb.db.transaction((tx) =>
        reserveStock(
          tx,
          i % 2
            ? [
                { productId: a.id, qty: 1 },
                { productId: b.id, qty: 1 },
              ]
            : [
                { productId: b.id, qty: 1 },
                { productId: a.id, qty: 1 },
              ],
        ),
      ),
    );
    const res = await Promise.all(jobs);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(await stockOf(a.id)).toBe(900);
    expect(await stockOf(b.id)).toBe(900);
  });

  it('a rolled back transaction gives the stock back; releaseStock restores units', async () => {
    const p = await mkProduct(tdb.db, { stock: 4 });
    await tdb.db
      .transaction(async (tx) => {
        await reserveStock(tx, [{ productId: p.id, qty: 4 }]);
        throw new Error('later step failed');
      })
      .catch(() => undefined);
    expect(await stockOf(p.id)).toBe(4);
    await tdb.db.transaction((tx) => reserveStock(tx, [{ productId: p.id, qty: 3 }]));
    await releaseStock(tdb.db, [{ productId: p.id, qty: 3 }]);
    expect(await stockOf(p.id)).toBe(4);
  });
});

describe('rate limit counters', () => {
  const now = new Date('2026-03-01T10:00:30Z');

  it('window start is aligned and stable inside the window', () => {
    expect(windowStartFor(now, 60).toISOString()).toBe('2026-03-01T10:00:00.000Z');
    expect(windowStartFor(new Date('2026-03-01T10:00:59.999Z'), 60).toISOString()).toBe(
      '2026-03-01T10:00:00.000Z',
    );
    expect(windowStartFor(new Date('2026-03-01T10:01:00Z'), 60).toISOString()).toBe(
      '2026-03-01T10:01:00.000Z',
    );
  });

  it('150 concurrent hits are all counted: no lost updates', async () => {
    const ws = windowStartFor(now, 60);
    const counts = await Promise.all(
      Array.from({ length: 150 }, () => hitRateLimit(tdb.db, 'ip:1.1.1.1', ws)),
    );
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
  });

  it('keys and windows are independent; undo never goes below zero; reset and purge work', async () => {
    const ws = windowStartFor(now, 60);
    await hitRateLimit(tdb.db, 'k:a', ws);
    expect(await hitRateLimit(tdb.db, 'k:b', ws)).toBe(1);
    expect(await hitRateLimit(tdb.db, 'k:a', new Date(ws.getTime() + 60_000))).toBe(1);
    await undoRateLimitHit(tdb.db, 'k:b', ws);
    await undoRateLimitHit(tdb.db, 'k:b', ws);
    expect(await hitRateLimit(tdb.db, 'k:b', ws)).toBe(1);
    await resetRateLimit(tdb.db, 'k:a');
    expect(await hitRateLimit(tdb.db, 'k:a', ws)).toBe(1);
    const purged = await purgeRateLimits(tdb.db, new Date(ws.getTime() + 30_000));
    expect(purged).toBeGreaterThan(0);
    expect(await hitRateLimit(tdb.db, 'k:b', ws)).toBe(1); // purged => starts over
  });
});

describe('job queue', () => {
  const now = new Date('2026-03-01T12:00:00Z');
  const clean = () => tdb.db.execute(sql`TRUNCATE jobs`);

  it('only due jobs are claimed, oldest first, and each claim bumps attempts', async () => {
    await clean();
    await enqueueJob(tdb.db, { type: 'late', payload: {}, runAt: new Date(now.getTime() + 1000) });
    await enqueueJob(tdb.db, {
      type: 'b',
      payload: { n: 2 },
      runAt: new Date(now.getTime() - 1000),
    });
    await enqueueJob(tdb.db, {
      type: 'a',
      payload: { n: 1 },
      runAt: new Date(now.getTime() - 5000),
    });
    const got = await claimJobs(tdb.db, { now, limit: 10 });
    expect(got.map((j) => j.type)).toEqual(['a', 'b']);
    expect(got.every((j) => j.attempts === 1)).toBe(true);
    // already running: a second poll gets nothing
    expect(await claimJobs(tdb.db, { now, limit: 10 })).toHaveLength(0);
    // time passes: the future job becomes due
    const later = await claimJobs(tdb.db, { now: new Date(now.getTime() + 2000), limit: 10 });
    expect(later.map((j) => j.type)).toEqual(['late']);
  });

  it('8 competing workers never receive the same job twice', async () => {
    await clean();
    for (let i = 0; i < 100; i++)
      await enqueueJob(tdb.db, { type: 'x', payload: { i }, runAt: now });
    const worker = async () => {
      const mine: number[] = [];
      for (;;) {
        const batch = await claimJobs(tdb.db, { now, limit: 7 });
        if (batch.length === 0) return mine;
        mine.push(...batch.map((j) => j.id));
        for (const j of batch) await completeJob(tdb.db, j.id);
      }
    };
    const all = (await Promise.all(Array.from({ length: 8 }, worker))).flat();
    expect(all).toHaveLength(100);
    expect(new Set(all).size).toBe(100);
    expect((await tdb.db.select().from(t.jobs)).length).toBe(0);
  });

  it("a crashed worker's job is picked up again after the stale timeout", async () => {
    await clean();
    await enqueueJob(tdb.db, { type: 'x', payload: {}, runAt: now });
    const first = await claimJobs(tdb.db, { now, limit: 1, staleAfterSeconds: 60 });
    expect(first).toHaveLength(1);
    expect(
      await claimJobs(tdb.db, {
        now: new Date(now.getTime() + 30_000),
        limit: 1,
        staleAfterSeconds: 60,
      }),
    ).toHaveLength(0);
    const again = await claimJobs(tdb.db, {
      now: new Date(now.getTime() + 61_000),
      limit: 1,
      staleAfterSeconds: 60,
    });
    expect(again.map((j) => [j.id, j.attempts])).toEqual([[first[0]!.id, 2]]);
  });

  it('failJob reschedules or parks the job', async () => {
    await clean();
    const id = await enqueueJob(tdb.db, { type: 'x', payload: {}, runAt: now });
    await claimJobs(tdb.db, { now, limit: 1 });
    const retryAt = new Date(now.getTime() + 10_000);
    await failJob(tdb.db, id, 'temporary', retryAt);
    expect(await claimJobs(tdb.db, { now, limit: 1 })).toHaveLength(0);
    expect(await claimJobs(tdb.db, { now: retryAt, limit: 1 })).toHaveLength(1);
    await failJob(tdb.db, id, 'x'.repeat(5000), null);
    const [row] = await tdb.db.select().from(t.jobs).where(eq(t.jobs.id, id));
    expect(row!.state).toBe('failed');
    expect(row!.lastError!.length).toBe(2000);
    expect(await claimJobs(tdb.db, { now: new Date(now.getTime() + 1e9), limit: 1 })).toHaveLength(
      0,
    );
  });
});
