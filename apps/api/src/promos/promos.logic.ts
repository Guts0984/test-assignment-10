import { desc, eq, sql } from 'drizzle-orm';
import { pgErrorCode, schema } from '@shop/db';
import {
  normalizePromoCode,
  type PromoCreate,
  type PromoDto,
  type PromoUpdate,
} from '@shop/shared';
import { type AppCtx } from '../ctx';
import { conflict, notFound, unprocessable } from '../http/errors';
import { type PromoRow } from './promo-store';

const { promoCodes, orders, promoRedemptions } = schema;

const toDto = (p: PromoRow): PromoDto => ({
  id: p.id,
  code: p.code,
  type: p.type,
  value: p.value,
  minOrder: p.minOrder,
  startsAt: p.startsAt?.toISOString() ?? null,
  expiresAt: p.expiresAt?.toISOString() ?? null,
  maxUses: p.maxUses,
  used: p.used,
  oncePerCustomer: p.oncePerCustomer,
  active: p.active,
  createdAt: p.createdAt.toISOString(),
});

export async function listPromos(ctx: AppCtx): Promise<PromoDto[]> {
  const rows = await ctx.db
    .select()
    .from(promoCodes)
    .orderBy(desc(promoCodes.createdAt), desc(promoCodes.id));
  return rows.map(toDto);
}

export async function getPromo(ctx: AppCtx, id: string): Promise<PromoDto> {
  const rows = await ctx.db.select().from(promoCodes).where(eq(promoCodes.id, id)).limit(1);
  if (!rows[0]) throw notFound('Promo code not found');
  return toDto(rows[0]);
}

export async function createPromo(ctx: AppCtx, input: PromoCreate): Promise<PromoDto> {
  try {
    const [row] = await ctx.db
      .insert(promoCodes)
      .values({
        code: normalizePromoCode(input.code),
        type: input.type,
        value: input.value,
        minOrder: input.minOrder,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        maxUses: input.maxUses,
        oncePerCustomer: input.oncePerCustomer,
        active: input.active,
        createdAt: ctx.clock.now(),
      })
      .returning();
    return toDto(row!);
  } catch (e) {
    if (pgErrorCode(e) === '23505')
      throw conflict('conflict', 'A promo code with this name already exists');
    throw e;
  }
}

export async function updatePromo(ctx: AppCtx, id: string, input: PromoUpdate): Promise<PromoDto> {
  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(promoCodes)
      .where(eq(promoCodes.id, id))
      .for('update')
      .limit(1);
    const cur = rows[0];
    if (!cur) throw notFound('Promo code not found');
    const next = {
      ...input,
      startsAt:
        input.startsAt === undefined ? undefined : input.startsAt ? new Date(input.startsAt) : null,
      expiresAt:
        input.expiresAt === undefined
          ? undefined
          : input.expiresAt
            ? new Date(input.expiresAt)
            : null,
    };
    if (next.maxUses !== undefined && next.maxUses !== null && next.maxUses < cur.used) {
      throw unprocessable(
        'validation_error',
        'maxUses cannot be below the number of times the code was already used',
        [{ path: 'maxUses', message: `already used ${cur.used} times` }],
      );
    }
    const starts = next.startsAt === undefined ? cur.startsAt : next.startsAt;
    const ends = next.expiresAt === undefined ? cur.expiresAt : next.expiresAt;
    if (starts && ends && starts >= ends) {
      throw unprocessable('validation_error', 'expiresAt must be after startsAt', [
        { path: 'expiresAt', message: 'must be after startsAt' },
      ]);
    }
    const [row] = await tx.update(promoCodes).set(next).where(eq(promoCodes.id, id)).returning();
    return toDto(row!);
  });
}

/** Never-used codes are deleted; codes that appear in orders are only deactivated (history stays intact). */
export async function deletePromo(ctx: AppCtx, id: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(promoCodes)
      .where(eq(promoCodes.id, id))
      .for('update')
      .limit(1);
    if (!rows[0]) throw notFound('Promo code not found');
    const refs = await tx.execute<{ n: string }>(sql`
      SELECT (SELECT count(*) FROM ${orders} WHERE promo_id = ${id}) + (SELECT count(*) FROM ${promoRedemptions} WHERE promo_id = ${id}) AS n`);
    if (Number(refs.rows[0]?.n ?? 0) > 0)
      await tx.update(promoCodes).set({ active: false }).where(eq(promoCodes.id, id));
    else await tx.delete(promoCodes).where(eq(promoCodes.id, id));
  });
}
