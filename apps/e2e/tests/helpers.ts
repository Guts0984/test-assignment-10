import { expect, type APIRequestContext, type Page, request as pwRequest } from '@playwright/test';

export const BASE = process.env.E2E_BASE_URL ?? '';

/** Seeded demo accounts (see README). Each test takes its own customer so carts and limits never collide. */
export const customer = (n: number) => ({
  email: `customer${n}@shop.test`,
  password: 'Customer123!',
});
export const MANAGER = { email: 'manager@shop.test', password: 'Manager123!' };

export async function uiLogin(page: Page, who: { email: string; password: string }, locale = 'en') {
  await page.goto(`/${locale}/login`);
  await page.getByLabel(locale === 'en' ? 'E-mail' : 'E-mail').fill(who.email);
  await page.getByLabel(locale === 'en' ? 'Password' : 'Пароль').fill(who.password);
  await page.getByRole('button', { name: locale === 'en' ? 'Sign in' : 'Увійти' }).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/?$`));
  await expect(
    page.getByRole('button', { name: locale === 'en' ? 'Sign out' : 'Вийти' }),
  ).toBeVisible();
}

/** A logged-in API client (for test SET-UP only: promo codes, stock, status changes). */
export async function apiAs(who: { email: string; password: string }): Promise<APIRequestContext> {
  const ctx = paced(
    await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } }),
  );
  const r = await ctx.post('/api/auth/login', { data: who });
  expect(r.status(), 'api login').toBe(200);
  return ctx;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'fetch', 'head']);

/**
 * nginx allows 40 requests/second per client (burst 80) - that limit is a feature and has its own
 * checks. A test loop must not trip it by accident, so every call waits a few ms and, if nginx's own
 * 429 page (HTML, the request never reached the app) still comes back, waits and repeats it.
 */
export function paced<T extends APIRequestContext>(ctx: T): T {
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || !VERBS.has(prop) || typeof v !== 'function') {
        return typeof v === 'function' ? v.bind(target) : v;
      }
      return async (...args: unknown[]) => {
        for (let i = 0; ; i++) {
          await sleep(30);
          const r = await (
            v as (...a: unknown[]) => Promise<import('@playwright/test').APIResponse>
          ).apply(target, args);
          if (r.status() !== 429 || i >= 8) return r;
          const body = await r.text();
          if (!body.trimStart().startsWith('<')) return r; // the app's own 429 is a real answer
          await sleep(400 * (i + 1));
        }
      };
    },
  });
}

export async function managerApi() {
  return apiAs(MANAGER);
}

export const uniqueCode = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    .toUpperCase()
    .slice(0, 30);

/** Creates a product with plenty of stock so a test never depends on the seeded random stock. */
export async function createProduct(
  mgr: APIRequestContext,
  o: { name: string; price: number; stock?: number },
) {
  const cats = await (await mgr.get('/api/categories')).json();
  const r = await mgr.post('/api/products', {
    data: { name: o.name, categoryId: cats[0].id, price: o.price, stock: o.stock ?? 50 },
  });
  expect(r.status()).toBe(201);
  return (await r.json()) as { id: string; name: string; price: number };
}

export async function createPromo(mgr: APIRequestContext, data: Record<string, unknown>) {
  const r = await mgr.post('/api/promos', { data });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()) as { id: string; code: string };
}

/** Puts a product into the customer's cart through the catalogue search + button, like a person would. */
export async function addToCartViaUi(page: Page, productName: string, times = 1) {
  await page.goto(`/en?q=${encodeURIComponent(productName)}`);
  const card = page.getByTestId('product-card').filter({ hasText: productName });
  await expect(card).toHaveCount(1);
  for (let i = 0; i < times; i++) await card.getByRole('button', { name: /Add to cart/ }).click();
  await expect(card.getByRole('button', { name: /Add to cart/ })).toContainText(`(${times})`);
}

export async function fillAddress(page: Page) {
  await page.getByLabel('Courier').check();
  await page.getByLabel('Full name').fill('Olena Shevchenko');
  await page.getByLabel('Phone').fill('+380501234567');
  await page.getByLabel('City').fill('Kyiv');
  await page.getByLabel('Street').fill('Khreshchatyk');
  await page.getByLabel('Building').fill('1');
  await page.getByLabel('Postal code').fill('01001');
}

/** Opens the payment stub in the new tab the app opens, and returns that tab. */
export async function openPaymentTab(page: Page) {
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('button', { name: 'Pay', exact: true }).click(),
  ]);
  await popup.waitForURL(/\/stub\/pay\//);
  await expect(popup.getByRole('button', { name: 'Success', exact: true })).toBeVisible();
  return popup;
}

export async function orderStatus(page: Page) {
  return page.getByTestId('order-status');
}

/** Empties the customer's cart (earlier runs / tests may have left things in it). */
export async function resetCart(who: { email: string; password: string }) {
  const api = await apiAs(who);
  const cart = await (await api.get('/api/cart')).json();
  for (const l of cart.lines) await api.delete(`/api/cart/items/${l.productId}`);
  if (cart.promo) await api.delete('/api/cart/promo');
  await api.dispose();
}

// ---------------------------------------------------------------------------------------------
// Helpers for the broad suites. Logging in is rate limited (that is a feature), so a test that is
// not ABOUT logging in must not spend the login budget: sessions are created once per account and
// reused (`api`, `loginAs`).
// ---------------------------------------------------------------------------------------------
import { createHmac, randomUUID } from 'node:crypto';

export const uuid = () => randomUUID();
export const WEBHOOK_SECRET = process.env.E2E_WEBHOOK_SECRET ?? '';
export const RELAXED = process.env.E2E_RELAXED !== '0';

type Who = { email: string; password: string };
const sessions = new Map<string, APIRequestContext>();

/** A logged-in API client for this account, created once and shared by every test in this worker. */
export async function api(who: Who): Promise<APIRequestContext> {
  const hit = sessions.get(who.email);
  if (hit) return hit;
  const ctx = await apiAs(who);
  sessions.set(who.email, ctx);
  return ctx;
}

/** Signs the page in WITHOUT the login form (cookie from the shared API session). */
export async function loginAs(page: Page, who: Who) {
  const ctx = await api(who);
  const state = await ctx.storageState();
  await page.context().addCookies(state.cookies);
}

/** A client with NO session (a visitor). */
export async function visitor(): Promise<APIRequestContext> {
  return paced(await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } }));
}

export type Order = {
  id: string;
  number: string;
  status: string;
  total: number;
  subtotal: number;
  discount: number;
  delivery: number;
  refundedTotal: number;
  pendingPayment: boolean;
  items: { id: string; productId: string; qty: number; returnedQty: number; net: number }[];
  events: { type: string; data: Record<string, unknown> }[];
  refunds: { amount: number; kind: string; status: string }[];
  promoCode: string | null;
};

export const COURIER_ADDRESS = {
  fullName: 'Olena Shevchenko',
  phone: '+380501234567',
  city: 'Kyiv',
  street: 'Khreshchatyk',
  building: '1',
  postalCode: '01001',
};

/** Empties the cart, puts the items in and places the order through the API. */
export async function makeOrder(
  who: Who,
  items: { productId: string; qty: number }[],
  o: { promo?: string; delivery?: 'pickup' | 'courier'; key?: string } = {},
): Promise<Order> {
  const c = await api(who);
  const cart = await (await c.get('/api/cart')).json();
  for (const l of cart.lines) await c.delete(`/api/cart/items/${l.productId}`);
  if (cart.promo) await c.delete('/api/cart/promo');
  for (const i of items) {
    const r = await c.put(`/api/cart/items/${i.productId}`, { data: { qty: i.qty } });
    expect(r.status(), await r.text()).toBe(200);
  }
  if (o.promo) {
    const r = await c.post('/api/cart/promo', { data: { code: o.promo } });
    expect(r.status(), await r.text()).toBe(200);
  }
  const delivery = o.delivery ?? 'pickup';
  const r = await c.post('/api/orders', {
    headers: { 'Idempotency-Key': o.key ?? uuid() },
    data: {
      deliveryMethod: delivery,
      ...(delivery === 'courier' ? { address: COURIER_ADDRESS } : {}),
    },
  });
  expect([200, 201], await r.text()).toContain(r.status());
  return (await r.json()) as Order;
}

export async function getOrder(who: Who, id: string): Promise<Order> {
  const r = await (await api(who)).get(`/api/orders/${id}`);
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as Order;
}

/** Polls until `ok(order)` (the order changes by itself: webhooks and jobs are asynchronous). */
export async function waitOrder(who: Who, id: string, ok: (o: Order) => boolean, ms = 30_000) {
  await expect
    .poll(async () => ok(await getOrder(who, id)), { timeout: ms, intervals: [250, 500, 1000] })
    .toBe(true);
  return getOrder(who, id);
}

export type Outcome = 'success' | 'failure' | 'success_delayed';

/** Starts a payment session for the order (what the Pay button does). */
export async function startPay(who: Who, orderId: string) {
  const r = await (await api(who)).post(`/api/orders/${orderId}/pay`, { data: {} });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as { paymentId: string; url: string };
}

/** What the person does on the stub page. */
export async function stubComplete(paymentId: string, outcome: Outcome) {
  const v = await visitor();
  const r = await v.post(`/api/stub/payments/${paymentId}/complete`, { data: { outcome } });
  const out = { status: r.status(), body: await r.text() };
  await v.dispose();
  return out;
}

export async function payOrder(who: Who, orderId: string, outcome: Outcome = 'success') {
  const { paymentId } = await startPay(who, orderId);
  const r = await stubComplete(paymentId, outcome);
  expect(r.status, r.body).toBeLessThan(300);
  return paymentId;
}

/** Order that is paid (waits for the webhook). */
export async function paidOrder(
  who: Who,
  items: { productId: string; qty: number }[],
  o: Parameters<typeof makeOrder>[2] = {},
) {
  const order = await makeOrder(who, items, o);
  await payOrder(who, order.id);
  return waitOrder(who, order.id, (x) => x.status === 'paid');
}

export const mgrStatus = async (orderId: string, status: 'shipped' | 'delivered') =>
  (await api(MANAGER)).patch(`/api/orders/${orderId}/status`, { data: { status } });

export async function deliveredOrder(
  who: Who,
  items: { productId: string; qty: number }[],
  o: Parameters<typeof makeOrder>[2] = {},
) {
  const order = await paidOrder(who, items, o);
  expect((await mgrStatus(order.id, 'shipped')).status()).toBe(200);
  expect((await mgrStatus(order.id, 'delivered')).status()).toBe(200);
  return getOrder(who, order.id);
}

export async function getProduct(id: string) {
  const r = await (await api(MANAGER)).get(`/api/products/${id}`);
  return (await r.json()) as {
    id: string;
    name: string;
    price: number;
    stock: number;
    active: boolean;
  };
}

export const patchProduct = async (id: string, data: Record<string, unknown>) =>
  (await api(MANAGER)).patch(`/api/products/${id}`, { data });

/** A signed notification, exactly as the payment provider would send it. */
export function webhookRequest(
  event: Record<string, unknown>,
  o: { secret?: string; at?: Date } = {},
) {
  const raw = JSON.stringify(event);
  const t = Math.floor((o.at ?? new Date()).getTime() / 1000);
  const mac = createHmac('sha256', o.secret ?? WEBHOOK_SECRET)
    .update(`${t}.`)
    .update(raw)
    .digest('hex');
  return { raw, signature: `t=${t},v1=${mac}` };
}

export async function sendWebhook(
  event: Record<string, unknown>,
  o: { secret?: string; at?: Date; signature?: string; body?: string } = {},
) {
  const v = await visitor();
  const { raw, signature } = webhookRequest(event, o);
  const r = await v.post('/api/payments/webhook', {
    data: Buffer.from(o.body ?? raw),
    headers: {
      'content-type': 'application/json',
      ...(o.signature === undefined
        ? { 'x-signature': signature }
        : o.signature
          ? { 'x-signature': o.signature }
          : {}),
    },
  });
  const out = { status: r.status(), body: await r.text() };
  await v.dispose();
  return out;
}

/** A unique name prefix so a test can find exactly its own products in the shared catalogue. */
export const tag = (p: string) =>
  `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Several products at once (default 50 in stock each). */
export async function makeProducts(
  mgr: APIRequestContext,
  list: { name: string; price: number; stock?: number }[],
) {
  const out = [];
  for (const p of list) out.push(await createProduct(mgr, p));
  return out;
}

export async function resetCartApi(who: Who) {
  const c = await api(who);
  const cart = await (await c.get('/api/cart')).json();
  for (const l of cart.lines) await c.delete(`/api/cart/items/${l.productId}`);
  if (cart.promo) await c.delete('/api/cart/promo');
}

/** Cancels every unpaid order of this customer (frees the "5 unpaid orders" limit between tests). */
export async function cancelOpenOrders(who: Who) {
  const c = await api(who);
  const list = await (await c.get('/api/orders?status=awaiting_payment&limit=50')).json();
  for (const o of list.items) await c.post(`/api/orders/${o.id}/cancel`, { data: {} });
}
