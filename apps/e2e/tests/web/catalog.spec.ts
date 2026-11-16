import { expect, test, type Locator } from '@playwright/test';
import {
  BASE,
  createProduct,
  customer,
  loginAs,
  makeProducts,
  managerApi,
  MANAGER,
  tag,
  visitor,
} from '../helpers';

const T = tag('Cat');
let ids: Record<string, string> = {};

test.beforeAll(async () => {
  const mgr = await managerApi();
  const made = await makeProducts(mgr, [
    { name: `${T} Alpha`, price: 1_000 },
    { name: `${T} Bravo`, price: 2_500 },
    { name: `${T} Charlie`, price: 2_500 }, // same price as Bravo: the order must still be stable
    { name: `${T} Delta`, price: 99_999 },
    { name: `${T} Echo`, price: 5_000, stock: 3 },
    { name: `${T} Foxtrot`, price: 700, stock: 0 },
  ]);
  ids = Object.fromEntries(made.map((p) => [p.name.replace(`${T} `, ''), p.id]));
  const hidden = await createProduct(mgr, { name: `${T} Hidden`, price: 100 });
  ids.Hidden = hidden.id;
  await mgr.patch(`/api/products/${hidden.id}`, { data: { active: false } });
});

const cards = (page: import('@playwright/test').Page) => page.getByTestId('product-card');
const names = async (c: Locator) =>
  (await c.getByRole('heading').allInnerTexts()).map((s) => s.replace(`${T} `, ''));
const prices = async (c: Locator) =>
  (await c.locator('p.text-lg').allInnerTexts()).map((s) => Number(s.replace(/[^\d.]/g, '')));

test.describe('search, filters and sorting', () => {
  test('search finds exactly the visible products with that text (the hidden one stays hidden)', async ({
    page,
  }) => {
    await page.goto(`/en?q=${T}`);
    await expect(cards(page)).toHaveCount(6);
    expect((await names(cards(page))).sort()).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
      'Echo',
      'Foxtrot',
    ]);
  });

  test('typing in the search box filters as you type and puts the query in the URL; "Reset filters" clears it', async ({
    page,
  }) => {
    await page.goto('/en');
    await page.getByLabel('Search products').fill(`${T} Echo`);
    await expect(cards(page)).toHaveCount(1);
    await expect(page).toHaveURL(new RegExp(`q=${T}`));
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(page.getByLabel('Search products')).toHaveValue('');
    expect(await cards(page).count()).toBeGreaterThan(6);
  });

  test('nothing found shows a message, not an empty page', async ({ page }) => {
    await page.goto(`/en?q=${T}-no-such-thing`);
    await expect(page.getByText('Nothing found. Try changing the filters.')).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
  });

  test('price range: only products inside it; a nonsense amount is explained and not applied', async ({
    page,
  }) => {
    await page.goto(`/en?q=${T}`);
    await page.getByLabel('Price from, ₴').fill('20');
    await page.getByLabel('Price to, ₴').fill('60');
    await expect(cards(page)).toHaveCount(3);
    expect((await names(cards(page))).sort()).toEqual(['Bravo', 'Charlie', 'Echo']);
    await page.getByLabel('Price from, ₴').fill('abc');
    await expect(page.getByText('Enter an amount like 12.50').first()).toBeVisible();
    await page.getByLabel('Price from, ₴').fill('25,00'); // comma decimals are accepted
    await page.getByLabel('Price to, ₴').fill('25');
    await expect(cards(page)).toHaveCount(2);
  });

  test('sort by price both ways and by name really orders the cards (ties are stable across reloads)', async ({
    page,
  }) => {
    await page.goto(`/en?q=${T}&sort=price_asc`);
    await expect(cards(page)).toHaveCount(6);
    const asc = await prices(cards(page));
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    const firstOrder = await names(cards(page));
    await page.reload();
    await expect(cards(page)).toHaveCount(6);
    expect(await names(cards(page))).toEqual(firstOrder);

    await page.getByLabel('Sort by').selectOption('price_desc');
    await expect(page).toHaveURL(/sort=price_desc/);
    await expect.poll(async () => (await prices(cards(page)))[0]).toBe(999.99);
    const desc = await prices(cards(page));
    expect(desc).toEqual([...desc].sort((a, b) => b - a));

    await page.getByLabel('Sort by').selectOption('name');
    await expect.poll(async () => (await names(cards(page)))[0]).toBe('Alpha');
    expect(await names(cards(page))).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
      'Echo',
      'Foxtrot',
    ]);
  });

  test('a category filter shows only that category; another category shows none of the test products', async ({
    page,
  }) => {
    const cats = await (await (await visitor()).get('/api/categories')).json();
    await page.goto(`/en?q=${T}`);
    await expect(page.getByLabel('Category').locator('option')).not.toHaveCount(1); // categories load asynchronously
    const options = await page.getByLabel('Category').locator('option').allInnerTexts();
    expect(options.length).toBeGreaterThan(2);
    // the test products are in the first category
    await page.getByLabel('Category').selectOption({ label: cats[0].name });
    await expect(page).toHaveURL(/category=/);
    await expect(cards(page)).toHaveCount(6);
    for (const c of await cards(page).all()) await expect(c).toContainText(cats[0].name);
    await page.getByLabel('Category').selectOption({ label: cats[1].name });
    await expect(page.getByText('Nothing found. Try changing the filters.')).toBeVisible();
  });

  test('filters in the URL are restored into the controls on a fresh load, and Back/Forward walk through them', async ({
    page,
  }) => {
    await page.goto(`/en?q=${T}&sort=price_desc`);
    await expect(page.getByLabel('Search products')).toHaveValue(T);
    await expect(page.getByLabel('Sort by')).toHaveValue('price_desc');
    await page.getByLabel('Sort by').selectOption('name');
    await expect(page).toHaveURL(/sort=name/);
    await page.goBack();
    await expect(page.getByLabel('Sort by')).toHaveValue('price_desc');
    await page.goForward();
    await expect(page.getByLabel('Sort by')).toHaveValue('name');
  });

  test('"Load more" appends the next page; hostile or absurd query strings do not break the page', async ({
    page,
  }) => {
    await page.goto('/en');
    await expect(cards(page)).toHaveCount(24);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect.poll(() => cards(page).count()).toBeGreaterThan(24);
    for (const q of [
      'q=' + 'x'.repeat(400),
      'q=%00',
      'sort=bogus',
      'minPrice=abc&maxPrice=-1',
      'category=not-a-uuid',
      'q[]=1',
    ]) {
      await page.goto(`/en?${q}`);
      await expect(page.getByRole('heading', { name: 'Catalog' }), q).toBeVisible();
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
    }
  });
});

test.describe('product cards and the product page', () => {
  test('stock labels: "Only 3 left" and "Out of stock" (the add button is disabled for the latter)', async ({
    page,
  }) => {
    await page.goto(`/en?q=${T}`);
    await expect(cards(page).filter({ hasText: `${T} Echo` })).toContainText('Only 3 left');
    const out = cards(page).filter({ hasText: `${T} Foxtrot` });
    await expect(out).toContainText('Out of stock');
    await expect(out.getByRole('button', { name: /Add to cart/ })).toBeDisabled();
  });

  test('a hidden product is invisible to visitors (list and direct link) but a manager sees it with a notice', async ({
    page,
    browser,
  }) => {
    await page.goto(`/en?q=${T} Hidden`);
    await expect(page.getByText('Nothing found. Try changing the filters.')).toBeVisible();
    await page.goto(`/en/products/${ids.Hidden}`);
    await expect(page.getByText('Product not found')).toBeVisible();

    const ctx = await browser.newContext({ baseURL: BASE });
    const mp = await ctx.newPage();
    await loginAs(mp, MANAGER);
    await mp.goto(`/en/products/${ids.Hidden}`);
    await expect(mp.getByRole('heading', { name: `${T} Hidden` })).toBeVisible();
    await expect(mp.getByText('This product is hidden from customers')).toBeVisible();
    await ctx.close();
  });

  test('a product name with HTML in it is shown as text everywhere and never runs', async ({
    page,
  }) => {
    const mgr = await managerApi();
    const nasty = `<img src=x onerror="window.__xss=1">${tag('X')}`;
    const p = await createProduct(mgr, { name: nasty, price: 1_234 });
    await page.goto(`/en?q=${encodeURIComponent(nasty)}`);
    await expect(cards(page).first()).toContainText('<img src=x onerror="window.__xss=1">');
    await page.goto(`/en/products/${p.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('<img');
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
  });

  test('keyboard: Tab to a product name and press Enter opens its page; the page has a way back', async ({
    page,
  }) => {
    await page.goto(`/en?q=${T} Alpha`);
    const link = cards(page)
      .first()
      .getByRole('link', { name: `${T} Alpha` });
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/en/products/${ids.Alpha}$`));
    await expect(page.getByRole('heading', { level: 1, name: `${T} Alpha` })).toBeVisible();
    await expect(page.getByText('₴10.00')).toBeVisible();
    await page.getByRole('link', { name: /Back to catalog/ }).click();
    await expect(page).toHaveURL(/\/en\/?$/);
  });

  test('a visitor who presses "Add to cart" is sent to the login and, after signing in, ends up back where they were', async ({
    page,
  }) => {
    await page.goto(`/en/products/${ids.Bravo}`);
    await page.getByRole('button', { name: /Add to cart/ }).click();
    await expect(page).toHaveURL(/\/en\/login\?next=/);
    await page.getByLabel('E-mail').fill(customer(13).email);
    await page.getByLabel('Password').fill(customer(13).password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(new RegExp(`/en/products/${ids.Bravo}$`));
    await expect(page.getByRole('heading', { level: 1, name: `${T} Bravo` })).toBeVisible();
  });

  test('"Add to cart" as a customer: the button counts, the header badge counts, the cart has the line', async ({
    page,
  }) => {
    await loginAs(page, customer(13));
    await page.goto(`/en?q=${T} Charlie`);
    const card = cards(page).first();
    await card.getByRole('button', { name: /Add to cart/ }).click();
    await expect(card.getByRole('button', { name: /Add to cart/ })).toContainText('(1)');
    await card.getByRole('button', { name: /Add to cart/ }).click();
    await expect(card.getByRole('button', { name: /Add to cart/ })).toContainText('(2)');
    await expect(page.getByTestId('cart-count')).toHaveText('2');
    await page.getByRole('link', { name: /Cart/ }).click();
    await expect(page.getByLabel(`Quantity of ${T} Charlie`)).toHaveValue('2');
    await page.getByRole('button', { name: `Remove ${T} Charlie from the cart` }).click();
    await expect(page.getByText('Your cart is empty.')).toBeVisible();
  });

  test('a manager sees no "Add to cart" button anywhere', async ({ page }) => {
    await loginAs(page, MANAGER);
    await page.goto(`/en?q=${T} Alpha`);
    await expect(cards(page).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Add to cart/ })).toHaveCount(0);
    await page.goto(`/en/products/${ids.Alpha}`);
    await expect(page.getByRole('button', { name: /Add to cart/ })).toHaveCount(0);
  });
});
