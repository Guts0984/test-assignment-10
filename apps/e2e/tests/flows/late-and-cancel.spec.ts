import { expect, test } from '@playwright/test';
import {
  addToCartViaUi,
  createProduct,
  customer,
  managerApi,
  openPaymentTab,
  uiLogin,
  resetCart,
} from '../helpers';

async function placeOrderViaUi(page: import('@playwright/test').Page, productName: string) {
  await addToCartViaUi(page, productName);
  await page.goto('/en/cart');
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
}

test('late notification: "success, but the notification arrives in 30 seconds" - the order updates by itself', async ({
  page,
}) => {
  const mgr = await managerApi();
  const p = await createProduct(mgr, { name: `E2E Late ${Date.now().toString(36)}`, price: 7_700 });
  await resetCart(customer(5));
  await uiLogin(page, customer(5));
  await placeOrderViaUi(page, p.name);
  await page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = 7));

  const stub = await openPaymentTab(page);
  await stub.getByRole('button', { name: /notification arrives in 30 seconds/ }).click();
  await expect(stub.getByText(/about 30 seconds/)).toBeVisible();
  await page.bringToFront();
  await expect(page.getByTestId('order-status')).toHaveText('Awaiting payment');
  await expect(page.getByText('Waiting for the payment confirmation…')).toBeVisible();

  // ~30 s later the signed notification arrives; no reload happens
  await expect(page.getByTestId('order-status')).toHaveText('Paid', { timeout: 60_000 });
  expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(
    7,
  );
});

test('cancel: an unpaid order is cancelled; a paid one is cancelled and the money comes back through the stub', async ({
  page,
}) => {
  const mgr = await managerApi();
  const p = await createProduct(mgr, {
    name: `E2E Cancel ${Date.now().toString(36)}`,
    price: 9_900,
    stock: 10,
  });
  await resetCart(customer(6));
  await uiLogin(page, customer(6));

  // 1) unpaid
  await placeOrderViaUi(page, p.name);
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await page.getByRole('button', { name: 'Yes, cancel' }).click();
  await expect(page.getByTestId('order-status')).toHaveText('Cancelled');
  await expect(page.getByText('Cancelled by you')).toBeVisible();

  // 2) paid
  await placeOrderViaUi(page, p.name);
  const stub = await openPaymentTab(page);
  await stub.getByRole('button', { name: 'Success', exact: true }).click();
  await page.bringToFront();
  await expect(page.getByTestId('order-status')).toHaveText('Paid', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await page.getByRole('button', { name: 'Yes, cancel' }).click();
  await expect(page.getByTestId('order-status')).toHaveText('Cancelled');
  // the refund goes through the stub and completes without a reload
  await expect(page.getByTestId('refunds')).toContainText('₴99.00', { timeout: 20_000 });
  await expect(page.getByTestId('refunds')).toContainText('returned', { timeout: 20_000 });
  await expect(page.getByTestId('order-history')).toContainText('Refund completed');
  await expect(page.getByTestId('order-refunded')).toHaveText('₴99.00');
});
