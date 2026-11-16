import { expect, type APIRequestContext, type Page, request as pwRequest } from '@playwright/test';

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8088';

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
  const ctx = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: BASE } });
  const r = await ctx.post('/api/auth/login', { data: who });
  expect(r.status(), 'api login').toBe(200);
  return ctx;
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
