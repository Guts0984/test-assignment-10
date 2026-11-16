/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely typed JSON responses */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@shop/db';
import { startTestApp, type TestApp } from './harness';
import { anon, makeProduct, makePromo, newClient, type Client } from './shop';

let app: TestApp;
let c: Client;
let other: Client;
beforeAll(async () => {
  app = await startTestApp({ env: { API_RATE_MAX_PER_IP: '1000000' } });
});
afterAll(async () => app.close());
beforeAll(async () => {
  c = await newClient(app);
  other = await newClient(app);
});

describe('cart', () => {
  it('lives on the server: the same cart for every device of the same customer', async () => {
    const p = await makeProduct(app, { price: 2500 });
    expect((await c.put(`/cart/items/${p.id}`, { qty: 2 })).status).toBe(200);
    // "another device" = a second session of the same user
    const { createSession } = await import('../src/auth/sessions');
    const second = await createSession(app.ctx, c.userId);
    const r = await (
      await import('./shop')
    )
      .clientFor(app, c.userId, c.email, `sid=${second.token}`)
      .get('/cart');
    expect(r.body.lines).toHaveLength(1);
    expect(r.body.lines[0]).toMatchObject({
      productId: p.id,
      qty: 2,
      unitPrice: 2500,
      subtotal: 5000,
    });
    expect(r.body.subtotal).toBe(5000);
    // and other customers do not see it
    expect((await other.get('/cart')).body.lines).toHaveLength(0);
  });

  it('PUT sets the quantity (not adds), DELETE removes, both return the fresh cart', async () => {
    const p = await makeProduct(app, { price: 100 });
    await c.put(`/cart/items/${p.id}`, { qty: 3 });
    const r = await c.put(`/cart/items/${p.id}`, { qty: 1 });
    expect(r.body.lines.find((l: any) => l.productId === p.id).qty).toBe(1);
    const d = await c.del(`/cart/items/${p.id}`);
    expect(d.status).toBe(200);
    expect(d.body.lines.some((l: any) => l.productId === p.id)).toBe(false);
    expect((await c.del(`/cart/items/${p.id}`)).status).toBe(200); // idempotent
  });

  it('rejects bad quantities, unknown / hidden products, malformed ids', async () => {
    const p = await makeProduct(app);
    const hidden = await makeProduct(app, { active: false });
    for (const qty of [0, -1, 1.5, 1000, '2', null, undefined])
      expect((await c.put(`/cart/items/${p.id}`, { qty })).status, String(qty)).toBe(400);
    expect((await c.put(`/cart/items/${hidden.id}`, { qty: 1 })).status).toBe(404);
    expect(
      (await c.put('/cart/items/00000000-0000-4000-8000-000000000000', { qty: 1 })).status,
    ).toBe(404);
    expect((await c.put('/cart/items/not-a-uuid', { qty: 1 })).status).toBe(400);
  });

  it('cart endpoints need a customer session', async () => {
    expect((await anon(app).get('/cart')).status).toBe(401);
    const m = await newClient(app, 'manager');
    expect((await m.get('/cart')).status).toBe(403);
  });

  it('a cart holds at most 100 different products', async () => {
    const full = await newClient(app);
    const ps = await Promise.all(Array.from({ length: 101 }, () => makeProduct(app)));
    for (const p of ps.slice(0, 100)) await full.put(`/cart/items/${p.id}`, { qty: 1 });
    expect((await full.put(`/cart/items/${ps[100]!.id}`, { qty: 1 })).status).toBe(422);
    expect((await full.put(`/cart/items/${ps[0]!.id}`, { qty: 5 })).status).toBe(200); // editing an existing line is fine
  }, 120_000);

  it('parallel adds of the same product keep exactly one line', async () => {
    const p = await makeProduct(app);
    const d = await newClient(app);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => d.put(`/cart/items/${p.id}`, { qty: i + 1 })),
    );
    const lines = (await d.get('/cart')).body.lines;
    expect(lines).toHaveLength(1);
  });
});

describe('price changes and stock problems are visible in the cart', () => {
  it('a changed price is flagged, the new price is used, and it needs confirmation', async () => {
    const p = await makeProduct(app, { price: 10_000, stock: 5 });
    const u = await newClient(app);
    await u.put(`/cart/items/${p.id}`, { qty: 2 });
    await app.tdb.db
      .update(schema.products)
      .set({ price: 12_000 })
      .where(eq(schema.products.id, p.id));
    const r = await u.get('/cart');
    expect(r.body.hasPriceChanges).toBe(true);
    expect(r.body.lines[0]).toMatchObject({
      priceSeen: 10_000,
      unitPrice: 12_000,
      priceChanged: true,
      subtotal: 24_000,
    });
    // changing the quantity does NOT silently confirm the new price
    const afterEdit = await u.put(`/cart/items/${p.id}`, { qty: 3 });
    expect(afterEdit.body.lines[0].priceChanged).toBe(true);
    const confirmed = await u.post('/cart/accept-prices');
    expect(confirmed.body.hasPriceChanges).toBe(false);
    expect(confirmed.body.lines[0]).toMatchObject({
      priceSeen: 12_000,
      unitPrice: 12_000,
      subtotal: 36_000,
    });
  });

  it('missing stock and deactivated products are flagged with the available amount', async () => {
    const p = await makeProduct(app, { stock: 2 });
    const q = await makeProduct(app, { stock: 9 });
    const u = await newClient(app);
    await u.put(`/cart/items/${p.id}`, { qty: 5 });
    await u.put(`/cart/items/${q.id}`, { qty: 1 });
    await app.tdb.db
      .update(schema.products)
      .set({ active: false })
      .where(eq(schema.products.id, q.id));
    const r = await u.get('/cart');
    expect(r.body.hasStockProblems).toBe(true);
    expect(r.body.lines.find((l: any) => l.productId === p.id)).toMatchObject({
      insufficientStock: true,
      available: 2,
      qty: 5,
    });
    expect(r.body.lines.find((l: any) => l.productId === q.id)).toMatchObject({
      inactive: true,
      insufficientStock: true,
      available: 0,
      subtotal: 0,
    });
  });
});

describe('promo codes in the cart', () => {
  let u: Client;
  beforeAll(async () => {
    u = await newClient(app);
    const p = await makeProduct(app, { price: 100_000, stock: 100 });
    await u.put(`/cart/items/${p.id}`, { qty: 1 }); // 1000 ₴
  });

  it('applies a code case-insensitively and shows the discount, delivery and totals', async () => {
    await makePromo(app, { code: 'SAVE10', type: 'percent', value: 10 });
    const r = await u.post('/cart/promo', { code: '  save10 ' });
    expect(r.status).toBe(200);
    expect(r.body.promo).toMatchObject({ code: 'SAVE10', valid: true, discount: 10_000 });
    expect(r.body).toMatchObject({
      subtotal: 100_000,
      discount: 10_000,
      afterDiscount: 90_000,
      delivery: { pickup: 0, courier: 10_000 },
    });
    expect(r.body.lines[0]).toMatchObject({ discountShare: 10_000, net: 90_000 });
  });

  it('every rejection reason is reported with a machine-readable code', async () => {
    const now = app.clock.now().getTime();
    await makePromo(app, { code: 'OLD', expiresAt: new Date(now - 1000) });
    await makePromo(app, { code: 'SOON', startsAt: new Date(now + 86_400_000) });
    await makePromo(app, { code: 'BIGONLY', minOrder: 500_000 });
    await makePromo(app, { code: 'USEDUP', maxUses: 1, used: 1 });
    await makePromo(app, { code: 'OFF', active: false });
    const reasons: Record<string, string> = {
      NOPE: 'not_found',
      OLD: 'expired',
      SOON: 'not_started',
      BIGONLY: 'min_order',
      USEDUP: 'limit_reached',
      OFF: 'inactive',
    };
    for (const [code, reason] of Object.entries(reasons)) {
      const r = await u.post('/cart/promo', { code });
      expect(r.status, code).toBe(422);
      expect(r.body.error).toMatchObject({ code: 'promo_rejected', details: { reason } });
    }
    expect((await u.post('/cart/promo', { code: 'BIGONLY' })).body.error.details.minOrder).toBe(
      500_000,
    );
    // a rejected code does not replace the one already applied
    expect((await u.get('/cart')).body.promo.code).toBe('SAVE10');
  });

  it('a per-customer code already used by this customer is refused ("already used")', async () => {
    const promo = await makePromo(app, { code: 'ONCE', maxUses: 100 });
    const buyer = await newClient(app);
    const o = await app.tdb.db
      .insert(schema.orders)
      .values({
        number: 99_000_001,
        userId: buyer.userId,
        idempotencyKey: crypto.randomUUID(),
        status: 'paid',
        deliveryMethod: 'pickup',
        subtotal: 1,
        total: 1,
        createdAt: new Date(),
      })
      .returning();
    await app.tdb.db.insert(schema.promoRedemptions).values({
      promoId: promo.id,
      userId: buyer.userId,
      orderId: o[0]!.id,
      oncePerCustomer: true,
    });
    const p = await makeProduct(app, { price: 1000 });
    await buyer.put(`/cart/items/${p.id}`, { qty: 1 });
    const r = await buyer.post('/cart/promo', { code: 'ONCE' });
    expect(r.body.error.details.reason).toBe('already_used');
  });

  it('the code is re-validated against the live cart: dropping below the minimum shows why the discount vanished', async () => {
    await makePromo(app, { code: 'MIN500', minOrder: 50_000 });
    const w = await newClient(app);
    const a = await makeProduct(app, { price: 60_000 });
    await w.put(`/cart/items/${a.id}`, { qty: 1 });
    expect((await w.post('/cart/promo', { code: 'MIN500' })).body.promo.valid).toBe(true);
    await w.del(`/cart/items/${a.id}`);
    const b = await makeProduct(app, { price: 10_000 });
    const r = await w.put(`/cart/items/${b.id}`, { qty: 1 });
    expect(r.body.promo).toMatchObject({
      code: 'MIN500',
      valid: false,
      reason: 'min_order',
      minOrder: 50_000,
      discount: 0,
    });
    expect(r.body.discount).toBe(0);
  });

  it('DELETE /cart/promo removes it', async () => {
    const r = await u.del('/cart/promo');
    expect(r.status).toBe(200);
    expect(r.body.promo).toBeNull();
    expect(r.body.discount).toBe(0);
  });

  it('rejects garbage codes', async () => {
    for (const code of ['', ' ', 'x'.repeat(65), 123, null, { $ne: 1 }]) {
      expect((await u.post('/cart/promo', { code })).status).toBe(400);
    }
    expect((await u.post('/cart/promo', { code: "'; DROP TABLE promo_codes;--" })).status).toBe(
      422,
    );
  });
});
