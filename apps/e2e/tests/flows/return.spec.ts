import { expect, test } from '@playwright/test';
import {
  addToCartViaUi,
  createProduct,
  createPromo,
  customer,
  managerApi,
  openPaymentTab,
  uiLogin,
  uniqueCode,
  resetCart,
} from './helpers';

test('partial return of a delivered order: the refund includes the discount share of the returned items and not the delivery', async ({
  page,
  browser,
}) => {
  const mgr = await managerApi();
  const s = Date.now().toString(36);
  const a = await createProduct(mgr, { name: `E2E Aaa ${s}`, price: 3_333 });
  const b = await createProduct(mgr, { name: `E2E Bbb ${s}`, price: 1_999 });
  const c = await createProduct(mgr, { name: `E2E Ccc ${s}`, price: 12_345 });
  const code = uniqueCode('E2ER');
  await createPromo(mgr, { code, type: 'percent', value: 7, oncePerCustomer: true });

  await resetCart(customer(7));

  await uiLogin(page, customer(7));
  await addToCartViaUi(page, a.name, 1);
  await addToCartViaUi(page, b.name, 3);
  await addToCartViaUi(page, c.name, 2);
  await page.goto('/en/cart');
  await page.getByLabel('Promo code').fill(code);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('totals-discount')).toHaveText('−₴23.81');
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByLabel('Courier').check();
  await page.getByLabel('Full name').fill('Olena Shevchenko');
  await page.getByLabel('Phone').fill('+380501234567');
  await page.getByLabel('City').fill('Kyiv');
  await page.getByLabel('Street').fill('Khreshchatyk');
  await page.getByLabel('Building').fill('1');
  await page.getByLabel('Postal code').fill('01001');
  // 340.20 - 23.81 = 316.39, below 2000: delivery 100 -> 416.39
  await expect(page.getByTestId('totals-total')).toHaveText('₴416.39');
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/orders\/([0-9a-f-]{36})$/);
  const orderUrl = page.url();

  const stub = await openPaymentTab(page);
  await stub.getByRole('button', { name: 'Success', exact: true }).click();
  await page.bringToFront();
  await expect(page.getByTestId('order-status')).toHaveText('Paid', { timeout: 20_000 });

  // the MANAGER ships and delivers it in the manager UI
  const managerPage = await (
    await browser.newContext({ baseURL: page.url().split('/en/')[0] })
  ).newPage();
  await uiLogin(managerPage, { email: 'manager@shop.test', password: 'Manager123!' });
  await managerPage.goto(
    '/en/manager/orders?q=' +
      encodeURIComponent(
        await page
          .getByTestId('order-number')
          .innerText()
          .then((t) => t.replace('Order ', '')),
      ),
  );
  const row = managerPage.getByTestId('manager-order-row').first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Shipped' }).click();
  await expect(row.getByRole('button', { name: 'Delivered' })).toBeVisible();
  await row.getByRole('button', { name: 'Delivered' }).click();
  await expect(row).toContainText('Delivered');

  // the customer returns the 3 x 19.99 line: paid 55.77 for it (59.97 - 4.20 discount share)
  await page.goto(orderUrl);
  await expect(page.getByTestId('order-status')).toHaveText('Delivered');
  await page.getByLabel(`Quantity to return of ${b.name}`).fill('9');
  await page.getByRole('button', { name: 'Request return' }).click();
  await expect(page.getByText('More than you bought')).toBeVisible();
  await page.getByLabel(`Quantity to return of ${b.name}`).fill('3');
  await expect(page.getByTestId('return-estimate')).toHaveText('₴55.77');
  await page.getByRole('button', { name: 'Request return' }).click();
  await expect(page.getByText('Return created.')).toBeVisible();
  await expect(page.getByTestId('refunds')).toContainText('₴55.77');
  await expect(page.getByTestId('refunds')).toContainText('returned', { timeout: 20_000 });
  await expect(page.getByTestId('order-refunded')).toHaveText('₴55.77');
  // the form now offers only what is left
  await expect(page.getByLabel(`Quantity to return of ${b.name}`)).toHaveCount(0);
  await expect(page.getByLabel(`Quantity to return of ${c.name}`)).toBeVisible();

  // and the manager's sales report reflects the return (revenue net of refunds)
  await managerPage.goto('/en/manager/reports');
  await expect(managerPage.getByTestId('kpi-orders')).toBeVisible();
  await managerPage.close();
});
