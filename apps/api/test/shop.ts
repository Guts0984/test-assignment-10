import { randomUUID } from 'node:crypto';
import { schema } from '@shop/db';
import { type WebhookEvent } from '@shop/shared';
import { createSession } from '../src/auth/sessions';
import { runDueJobs } from '../src/jobs/worker';
import { signPayload } from '../src/payments/signature';
import { createUser, request, startTestApp, type Res, type TestApp } from './harness';

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper: responses are asserted field by field

export type Client = {
  userId: string;
  email: string;
  cookie: string;
  get: (path: string, ip?: string) => Promise<Res & { body: Json }>;
  post: (
    path: string,
    body?: unknown,
    o?: { key?: string; ip?: string; headers?: Record<string, string> },
  ) => Promise<Res & { body: Json }>;
  put: (path: string, body?: unknown) => Promise<Res & { body: Json }>;
  patch: (path: string, body?: unknown) => Promise<Res & { body: Json }>;
  del: (path: string) => Promise<Res & { body: Json }>;
};

const wrap = (r: Res) => Object.assign(r, { body: (r.json ?? {}) as Json });

export function clientFor(app: TestApp, userId: string, email: string, cookie: string): Client {
  const call = (
    method: string,
    path: string,
    body?: unknown,
    o: { ip?: string; headers?: Record<string, string> } = {},
  ) => request(app, method, path, { body, cookie, ip: o.ip, headers: o.headers }).then(wrap);
  return {
    userId,
    email,
    cookie,
    get: (path, ip) => call('GET', path, undefined, { ip }),
    post: (path, body, o = {}) =>
      call('POST', path, body ?? {}, {
        ip: o.ip,
        headers: { ...(o.key ? { 'Idempotency-Key': o.key } : {}), ...(o.headers ?? {}) },
      }),
    put: (path, body) => call('PUT', path, body),
    patch: (path, body) => call('PATCH', path, body),
    del: (path) => call('DELETE', path),
  };
}

/** A logged-in user without going through scrypt login (sessions are created directly). */
export async function newClient(
  app: TestApp,
  role: 'customer' | 'manager' = 'customer',
): Promise<Client> {
  const u = await createUser(app.tdb, { role });
  const s = await createSession(app.ctx, u.id);
  return clientFor(app, u.id, u.email, `sid=${s.token}`);
}

export const anon = (app: TestApp): Client => clientFor(app, '', '', '');

export async function makeProduct(
  app: TestApp,
  o: { name?: string; price?: number; stock?: number; active?: boolean; categoryId?: string } = {},
) {
  let categoryId = o.categoryId;
  if (!categoryId) {
    categoryId = randomUUID();
    await app.tdb.db
      .insert(schema.categories)
      .values({ id: categoryId, name: `cat-${categoryId}`, slug: `cat-${categoryId}` });
  }
  const [p] = await app.tdb.db
    .insert(schema.products)
    .values({
      name: o.name ?? `Product ${randomUUID().slice(0, 6)}`,
      categoryId,
      price: o.price ?? 10_000,
      stock: o.stock ?? 10,
      active: o.active ?? true,
      createdAt: app.clock.now(),
    })
    .returning();
  return p!;
}

export async function makePromo(
  app: TestApp,
  o: Partial<typeof schema.promoCodes.$inferInsert> & { code: string },
) {
  const [p] = await app.tdb.db
    .insert(schema.promoCodes)
    .values({ type: 'percent', value: 10, ...o, code: o.code.toUpperCase() })
    .returning();
  return p!;
}

export const COURIER_ADDRESS = {
  fullName: 'Olena Shevchenko',
  phone: '+380501234567',
  city: 'Kyiv',
  street: 'Khreshchatyk',
  building: '1',
  postalCode: '01001',
};

/** cart -> order. Returns the order (asserting success unless `expectStatus` says otherwise). */
export async function placeOrder(
  c: Client,
  items: { productId: string; qty: number }[],
  o: { promo?: string; delivery?: 'pickup' | 'courier'; key?: string; expectedTotal?: number } = {},
) {
  for (const i of items) {
    const r = await c.put(`/cart/items/${i.productId}`, { qty: i.qty });
    if (r.status !== 200) throw new Error(`cart put failed: ${r.status} ${r.text}`);
  }
  if (o.promo) {
    const r = await c.post('/cart/promo', { code: o.promo });
    if (r.status !== 200) throw new Error(`promo failed: ${r.status} ${r.text}`);
  }
  const delivery = o.delivery ?? 'pickup';
  return c.post(
    '/orders',
    {
      deliveryMethod: delivery,
      ...(delivery === 'courier' ? { address: COURIER_ADDRESS } : {}),
      ...(o.expectedTotal !== undefined ? { expectedTotal: o.expectedTotal } : {}),
    },
    { key: o.key ?? randomUUID() },
  );
}

/** What the payment provider does: send a signed notification to the shop. */
export function webhookEvent(
  partial: Partial<WebhookEvent> & {
    type: WebhookEvent['type'];
    orderId: string;
    paymentId: string;
    amount: number;
  },
): WebhookEvent {
  return {
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    ...partial,
  } as WebhookEvent;
}

export function sendWebhook(
  app: TestApp,
  event: unknown,
  o: { secret?: string; at?: Date; signature?: string | null; rawBody?: string; ip?: string } = {},
) {
  const rawBody = o.rawBody ?? JSON.stringify(event);
  const headers: Record<string, string> = {};
  if (o.signature !== null) {
    headers['X-Signature'] =
      o.signature ??
      signPayload(o.secret ?? app.env.WEBHOOK_SECRET, rawBody, o.at ?? app.clock.now());
  }
  return request(app, 'POST', '/payments/webhook', { rawBody, headers, ip: o.ip }).then(wrap);
}

/** Customer opens the payment page (POST /orders/:id/pay) and returns the payment id. */
export async function startPay(c: Client, orderId: string): Promise<string> {
  const r = await c.post(`/orders/${orderId}/pay`, {});
  if (r.status !== 200) throw new Error(`pay failed: ${r.status} ${r.text}`);
  return r.body.paymentId as string;
}

export const stubClick = (
  app: TestApp,
  paymentId: string,
  outcome: 'success' | 'failure' | 'success_delayed',
) => request(app, 'POST', `/stub/payments/${paymentId}/complete`, { body: { outcome } }).then(wrap);

/** pay + provider notifies success (the normal happy path) */
export async function payOrder(app: TestApp, c: Client, orderId: string): Promise<string> {
  const paymentId = await startPay(c, orderId);
  const r = await stubClick(app, paymentId, 'success');
  if (r.status !== 200) throw new Error(`stub failed: ${r.status} ${r.text}`);
  return paymentId;
}

/** Runs jobs until the queue has nothing due (refund notifications are jobs too). */
export async function drainJobs(app: TestApp): Promise<number> {
  let total = 0;
  for (let i = 0; i < 50; i++) {
    const n = await runDueJobs(app.ctx);
    total += n;
    if (n === 0) break;
  }
  return total;
}
export const runJobs = drainJobs;

export const getOrder = async (c: Client, id: string) => (await c.get(`/orders/${id}`)).body;

export async function stockOf(app: TestApp, productId: string): Promise<number> {
  const r = await app.tdb.db.query.products.findFirst({
    where: (p, { eq }) => eq(p.id, productId),
  });
  return r!.stock;
}

export { startTestApp };
