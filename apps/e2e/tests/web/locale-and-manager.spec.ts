import { expect, test } from '@playwright/test';
import { createProduct, customer, managerApi, resetCart, uiLogin, uniqueCode } from '../helpers';

test('uk and en: money, dates and plurals follow the locale', async ({ page }) => {
  const mgr = await managerApi();
  const s = Date.now().toString(36);
  const p1 = await createProduct(mgr, { name: `E2E Loc ${s}`, price: 123_450 });
  await resetCart(customer(8));
  await uiLogin(page, customer(8));
  await page.goto(`/uk?q=${encodeURIComponent(p1.name)}`);
  const card = page.getByTestId('product-card').filter({ hasText: p1.name });
  await expect(card).toContainText(/1\s234,50\s₴/);
  await card.getByRole('button', { name: /У кошик/ }).click();
  await card.getByRole('button', { name: /У кошик/ }).click();
  await card.getByRole('button', { name: /У кошик/ }).click();
  await page.goto('/uk/cart');
  await expect(page.getByTestId('totals-subtotal')).toHaveText(/3\s703,50\s₴/);
  // switch language on the same page: the same cart, English format
  await page.getByRole('group', { name: 'Мова' }).getByRole('button', { name: 'EN' }).click();
  await expect(page).toHaveURL(/\/en\/cart/);
  await expect(page.getByTestId('totals-subtotal')).toHaveText('₴3,703.50');
  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();
  // clean up the cart for later runs
  await page.getByRole('button', { name: /Remove .* from the cart/ }).click();
});

test('manager: create a product and a promo code, search, filters and report period live in the URL', async ({
  page,
}) => {
  const s = Date.now().toString(36);
  await uiLogin(page, { email: 'manager@shop.test', password: 'Manager123!' });

  await page.goto('/en/manager/products');
  await page.getByRole('button', { name: 'New product' }).click();
  const form = page.getByRole('form', { name: 'New product' });
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText('This field is required').first()).toBeVisible();
  await form.getByLabel('Name').fill(`E2E Managed ${s}`);
  await form.getByLabel('Category').selectOption({ index: 1 });
  await form.getByLabel('Price, ₴').fill('49,90');
  await form.getByLabel('Stock').fill('12');
  await form.getByRole('button', { name: 'Save' }).click();
  await page.getByLabel('Search', { exact: true }).fill(`E2E Managed ${s}`);
  const row = page.getByTestId('manager-product-row').filter({ hasText: `E2E Managed ${s}` });
  await expect(row).toContainText('₴49.90');
  await row.getByLabel(/Stock: /).fill('7');
  await row.getByRole('button', { name: 'Save stock' }).click();
  await expect(row.getByLabel(/Stock: /)).toHaveValue('7');

  await page.goto('/en/manager/promos');
  await page.getByRole('button', { name: 'New promo code' }).click();
  const code = uniqueCode('E2EP');
  const promoForm = page.getByRole('form', { name: 'New promo code' });
  await promoForm.getByLabel('Code', { exact: true }).fill(code);
  await promoForm.getByLabel('Discount, %').fill('150');
  await promoForm.getByRole('button', { name: 'Create' }).click();
  await expect(promoForm.getByText('Percent must be between 1 and 100')).toBeVisible();
  await promoForm.getByLabel('Discount, %').fill('12');
  await promoForm.getByLabel('Total uses limit (empty = unlimited)').fill('3');
  await promoForm.getByRole('button', { name: 'Create' }).click();
  const promoRow = page.getByTestId('promo-row').filter({ hasText: code });
  await expect(promoRow).toContainText('12%');
  await expect(promoRow.getByTestId('promo-used')).toHaveText('0 / 3');

  // orders: filters are in the URL and survive a reload
  await page.goto('/en/manager/orders');
  await page.getByLabel('Status').selectOption('delivered');
  await expect(page).toHaveURL(/status=delivered/);
  await expect(page.getByTestId('manager-order-row').first()).toBeVisible();
  await page.getByLabel('From').fill('2026-01-01');
  await expect(page).toHaveURL(/from=2026-01-01/);
  await page.reload();
  await expect(page.getByLabel('Status')).toHaveValue('delivered');
  await expect(page.getByLabel('From')).toHaveValue('2026-01-01');
  await page.goBack();
  await expect(page).not.toHaveURL(/from=2026-01-01/);

  // report period in the URL
  await page.goto('/en/manager/reports?from=2026-09-01&to=2026-09-30');
  await expect(page.getByTestId('kpi-orders')).toBeVisible();
  await expect(page.getByLabel('From')).toHaveValue('2026-09-01');
  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await expect(page).toHaveURL(/from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d/);
  await expect(page.getByTestId('kpi-revenue')).toBeVisible();
});

test('access control in the UI: a customer cannot open manager pages, a visitor is sent to the login', async ({
  page,
}) => {
  await page.goto('/en/cart');
  await expect(page).toHaveURL(/\/en\/login\?next=%2Fcart/);
  await resetCart(customer(9));
  await uiLogin(page, customer(9));
  await page.goto('/en/manager/orders');
  await expect(page.getByText('You do not have access to this page.')).toBeVisible();
  const direct = await page.request.get('/api/promos');
  expect(direct.status()).toBe(403);
  const mgrOrders = await page.request.get('/api/orders?limit=1');
  expect(mgrOrders.status()).toBe(200); // a customer's own list, not everybody's
});
