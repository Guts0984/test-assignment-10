import { randomUUID } from 'node:crypto';
import { type Db } from '../src/client';
import * as t from '../src/schema';

export async function mkUser(db: Db, email = `u${randomUUID().slice(0, 8)}@x.test`) {
  const [u] = await db
    .insert(t.users)
    .values({ email, name: 'U', passwordHash: 'x', role: 'customer' })
    .returning();
  return u!;
}

export async function mkCategory(db: Db) {
  const id = randomUUID();
  await db.insert(t.categories).values({ id, name: `c-${id}`, slug: `c-${id}` });
  return id;
}

export async function mkProduct(
  db: Db,
  o: { stock?: number; price?: number; active?: boolean; categoryId?: string; name?: string } = {},
) {
  const categoryId = o.categoryId ?? (await mkCategory(db));
  const [p] = await db
    .insert(t.products)
    .values({
      name: o.name ?? 'P',
      categoryId,
      price: o.price ?? 1000,
      stock: o.stock ?? 10,
      active: o.active ?? true,
    })
    .returning();
  return p!;
}

export async function mkOrder(
  db: Db,
  userId: string,
  o: Partial<typeof t.orders.$inferInsert> = {},
) {
  const number = o.number ?? Math.floor(Math.random() * 1e9) + 100_000;
  const [r] = await db
    .insert(t.orders)
    .values({
      number,
      userId,
      idempotencyKey: randomUUID(),
      status: 'awaiting_payment',
      deliveryMethod: 'pickup',
      subtotal: 1000,
      discount: 0,
      delivery: 0,
      total: 1000,
      createdAt: new Date(),
      ...o,
    })
    .returning();
  return r!;
}

/** Runs `fn` and returns the PostgreSQL error code it fails with (undefined when it succeeds). */
export async function sqlState(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.code ?? err.cause?.code ?? 'unknown';
  }
}
