import { expect, test } from '@playwright/test';
import {
  addToCartViaUi,
  createProduct,
  createPromo,
  customer,
  fillAddress,
  managerApi,
  openPaymentTab,
  uiLogin,
  uniqueCode,
  resetCart,
} from '../helpers';

test('cart -> checkout -> pay on the stub -> status updates WITHOUT reloading the page', async ({
  page,
}) => {
  const mgr = await managerApi();
  const suffix = Date.now().toString(36);
  const a = await createProduct(mgr, { name: `E2E Lamp ${suffix}`, price: 123_450 });
  const b = await createProduct(mgr, { name: `E2E Mug ${suffix}`, price: 3_333 });
  const code = uniqueCode('E2E7');
  await createPromo(mgr, { code, type: 'percent', value: 7, oncePerCustomer: true });

  await resetCart(customer(3));

  await uiLogin(page, customer(3));

  // catalogue filters are in the URL and "Back" restores them
  await page.goto('/en');
  await page.getByLabel('Category').selectOption({ index: 1 });
  await expect(page).toHaveURL(/category=/);
  await page.getByLabel('Sort by').selectOption('price_asc');
  await expect(page).toHaveURL(/sort=price_asc/);
  await page.goBack();
  await expect(page).not.toHaveURL(/sort=price_asc/);
  await expect(page).toHaveURL(/category=/);

  await addToCartViaUi(page, a.name, 2);
  await addToCartViaUi(page, b.name, 1);

  await page.getByRole('link', { name: /Cart/ }).click();
  await expect(page.getByTestId('cart-line')).toHaveCount(2);
  // 2 x 1 234.50 + 33.33
  await expect(page.getByTestId('totals-subtotal')).toHaveText('₴2,502.33');

  // a wrong code explains itself, the right one gives a discount
  await page.getByLabel('Promo code').fill('NO-SUCH-CODE');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('This promo code does not exist.')).toBeVisible();
  await page.getByLabel('Promo code').fill(code.toLowerCase());
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('totals-discount')).toHaveText('−₴175.16'); // floor(250233 * 7%)
  await expect(page.getByTestId('totals-total')).toHaveText('₴2,327.17');

  await page.getByRole('link', { name: 'Checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
  // form errors next to the fields; nothing is sent
  await page.getByLabel('Courier').check();
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByText('This field is required').first()).toBeVisible();
  await expect(page).toHaveURL(/\/checkout/);
  await fillAddress(page);
  await expect(page.getByTestId('totals-total')).toHaveText('₴2,327.17'); // above 2000 ₴ after discount: delivery is free
  await page.getByRole('button', { name: 'Place order' }).click();

  // the order page: reservation timer, then pay in the stub's tab
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('order-status')).toHaveText('Awaiting payment');
  await expect(page.getByTestId('reservation-timer')).toContainText(/\d\d:\d\d/);
  await page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = 42));

  const stub = await openPaymentTab(page);
  await expect(stub.getByText(/Amount to pay: ₴2,327.17/)).toBeVisible();
  await stub.getByRole('button', { name: 'Success', exact: true }).click();
  await expect(stub.getByText('Payment sent.')).toBeVisible();

  // back on the ORIGINAL tab: it changed by itself, and the page was never reloaded
  await page.bringToFront();
  await expect(page.getByTestId('order-status')).toHaveText('Paid', { timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(
    42,
  );
  await expect(page.getByTestId('order-history')).toContainText('Order created');
  await expect(page.getByTestId('order-history')).toContainText('Paid');
  await expect(page.getByTestId('order-total')).toHaveText('₴2,327.17');
  await expect(page.getByTestId('reservation-timer')).toHaveCount(0);
});

test('a declined payment keeps the order open and the customer can pay again', async ({ page }) => {
  const mgr = await managerApi();
  const p = await createProduct(mgr, {
    name: `E2E Declined ${Date.now().toString(36)}`,
    price: 5_000,
  });
  await resetCart(customer(4));
  await uiLogin(page, customer(4));
  await addToCartViaUi(page, p.name);
  await page.goto('/en/cart');
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);

  let stub = await openPaymentTab(page);
  await stub.getByRole('button', { name: 'Declined' }).click();
  await expect(stub.getByText('Payment declined.')).toBeVisible();
  await page.bringToFront();
  await expect(page.getByTestId('order-history')).toContainText('Payment failed');
  await expect(page.getByTestId('order-status')).toHaveText('Awaiting payment');

  stub = await openPaymentTab(page);
  await stub.getByRole('button', { name: 'Success', exact: true }).click();
  await page.bringToFront();
  await expect(page.getByTestId('order-status')).toHaveText('Paid', { timeout: 20_000 });
});
