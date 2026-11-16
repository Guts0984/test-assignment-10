import { and, asc, desc, eq, gte, ilike, lte, sql, type SQL } from 'drizzle-orm';
import { schema } from '@shop/db';
import {
  type Page,
  type ProductCreate,
  type ProductDto,
  type ProductQuery,
  type ProductUpdate,
} from '@shop/shared';
import { type AppCtx } from '../ctx';
import { decodeCursor, encodeCursor, UUID_RE } from '../http/cursor';
import { conflict, notFound, unprocessable } from '../http/errors';

const { products, categories } = schema;

const columns = {
  id: products.id,
  name: products.name,
  categoryId: products.categoryId,
  categoryName: categories.name,
  categorySlug: categories.slug,
  price: products.price,
  stock: products.stock,
  active: products.active,
  createdAt: products.createdAt,
};

type Row = {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  price: number;
  stock: number;
  active: boolean;
  createdAt: Date;
};

const toDto = (r: Row): ProductDto => ({ ...r, createdAt: r.createdAt.toISOString() });

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/**
 * Catalogue with search, category/price filters, sorting and KEYSET pagination.
 * The cursor holds the last row's sort value + id, so pages stay stable while stock changes.
 */
export async function listProducts(
  ctx: AppCtx,
  q: ProductQuery,
  opts: { canSeeInactive: boolean },
): Promise<Page<ProductDto>> {
  const where: SQL[] = [];
  if (!(opts.canSeeInactive && q.includeInactive)) where.push(eq(products.active, true));
  if (q.q) where.push(ilike(products.name, `%${escapeLike(q.q)}%`));
  if (q.category) where.push(eq(categories.slug, q.category));
  if (q.minPrice !== undefined) where.push(gte(products.price, q.minPrice));
  if (q.maxPrice !== undefined) where.push(lte(products.price, q.maxPrice));

  const idCheck = (v: Record<string, unknown>) =>
    typeof v.id === 'string' && UUID_RE.test(v.id) ? v.id : null;
  if (q.cursor) {
    const c = q.cursor;
    switch (q.sort) {
      case 'newest': {
        const k = decodeCursor(c, (v) => {
          const id = idCheck(v);
          return id && typeof v.c === 'string' && !Number.isNaN(Date.parse(v.c))
            ? { c: v.c, id }
            : null;
        });
        where.push(
          sql`(${products.createdAt}, ${products.id}) < (${new Date(k.c)}, ${k.id}::uuid)`,
        );
        break;
      }
      case 'price_asc':
      case 'price_desc': {
        const k = decodeCursor(c, (v) => {
          const id = idCheck(v);
          return id && Number.isSafeInteger(v.p) ? { p: v.p as number, id } : null;
        });
        where.push(
          q.sort === 'price_asc'
            ? sql`(${products.price}, ${products.id}) > (${k.p}, ${k.id}::uuid)`
            : sql`(${products.price}, ${products.id}) < (${k.p}, ${k.id}::uuid)`,
        );
        break;
      }
      case 'name': {
        const k = decodeCursor(c, (v) => {
          const id = idCheck(v);
          return id && typeof v.n === 'string' ? { n: v.n, id } : null;
        });
        where.push(sql`(${products.name}, ${products.id}) > (${k.n}, ${k.id}::uuid)`);
        break;
      }
    }
  }

  const order =
    q.sort === 'price_asc'
      ? [asc(products.price), asc(products.id)]
      : q.sort === 'price_desc'
        ? [desc(products.price), desc(products.id)]
        : q.sort === 'name'
          ? [asc(products.name), asc(products.id)]
          : [desc(products.createdAt), desc(products.id)];

  const rows = await ctx.db
    .select(columns)
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(...order)
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const hasMore = rows.length > q.limit && last !== undefined;
  const nextCursor = hasMore
    ? q.sort === 'newest'
      ? encodeCursor({ c: last.createdAt.toISOString(), id: last.id })
      : q.sort === 'name'
        ? encodeCursor({ n: last.name, id: last.id })
        : encodeCursor({ p: last.price, id: last.id })
    : null;
  return { items: page.map(toDto), nextCursor };
}

export async function getProduct(
  ctx: AppCtx,
  id: string,
  opts: { canSeeInactive: boolean },
): Promise<ProductDto> {
  const rows = await ctx.db
    .select(columns)
    .from(products)
    .innerJoin(categories, eq(categories.id, products.categoryId))
    .where(eq(products.id, id))
    .limit(1);
  const r = rows[0];
  if (!r || (!r.active && !opts.canSeeInactive)) throw notFound('Product not found');
  return toDto(r);
}

async function assertCategory(ctx: AppCtx, id: string): Promise<void> {
  const r = await ctx.db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, id))
    .limit(1);
  if (!r[0])
    throw unprocessable('validation_error', 'Unknown category', [
      { path: 'categoryId', message: 'unknown category' },
    ]);
}

export async function createProduct(ctx: AppCtx, input: ProductCreate): Promise<ProductDto> {
  await assertCategory(ctx, input.categoryId);
  const [row] = await ctx.db
    .insert(products)
    .values({ ...input, createdAt: ctx.clock.now() })
    .returning({ id: products.id });
  return getProduct(ctx, row!.id, { canSeeInactive: true });
}

export async function updateProduct(
  ctx: AppCtx,
  id: string,
  input: ProductUpdate,
): Promise<ProductDto> {
  if (input.categoryId) await assertCategory(ctx, input.categoryId);
  const { stockDelta, ...fields } = input;
  const set: Record<string, unknown> = { ...fields };
  // a relative change is computed by the database from the CURRENT stock (never from what the
  // manager's screen showed minutes ago), and may not leave 0..1 000 000
  if (stockDelta !== undefined) set.stock = sql`${products.stock} + ${stockDelta}`;
  const rows = await ctx.db
    .update(products)
    .set(set)
    .where(
      and(
        eq(products.id, id),
        stockDelta === undefined
          ? undefined
          : sql`${products.stock} + ${stockDelta} BETWEEN 0 AND 1000000`,
      ),
    )
    .returning({ id: products.id });
  if (!rows[0]) {
    const exists = await ctx.db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, id))
      .limit(1);
    if (!exists[0]) throw notFound('Product not found');
    throw conflict(
      'conflict',
      'The stock changed in the meantime: this change would take it below 0 (or above the limit). Reload and try again.',
    );
  }
  return getProduct(ctx, id, { canSeeInactive: true });
}

/** Products referenced by orders can never be deleted; "delete" hides them from the shop. */
export async function deactivateProduct(ctx: AppCtx, id: string): Promise<void> {
  const rows = await ctx.db
    .update(products)
    .set({ active: false })
    .where(eq(products.id, id))
    .returning({ id: products.id });
  if (!rows[0]) throw notFound('Product not found');
}

export async function listCategories(ctx: AppCtx) {
  return ctx.db
    .select({ id: categories.id, name: categories.name, slug: categories.slug })
    .from(categories)
    .orderBy(asc(categories.name));
}
