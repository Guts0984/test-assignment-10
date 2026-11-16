import { expect, test } from '@playwright/test';

test('a catalog card opens its product page; unknown ids show "not found"', async ({ page }) => {
  await page.goto('/en');
  const card = page.getByTestId('product-card').first();
  const name = (await card.getByRole('heading').innerText()).trim();
  const price = (await card.locator('p.text-lg').innerText()).trim();

  await card.getByRole('link', { name }).click();
  await expect(page).toHaveURL(/\/en\/products\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByText(price, { exact: true })).toBeVisible();

  await page.getByRole('link', { name: /Back to catalog/ }).click();
  await expect(page).toHaveURL(/\/en\/?$/);

  for (const bad of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
    await page.goto(`/en/products/${bad}`);
    await expect(page.getByText('Product not found')).toBeVisible();
  }
});

test('visitor: "Add to cart" on the product page sends them to log in', async ({ page }) => {
  await page.goto('/en');
  await page.getByTestId('product-card').first().getByRole('link').click();
  await expect(page).toHaveURL(/\/en\/products\//);
  await page.getByRole('button', { name: /Add to cart/ }).click();
  await expect(page).toHaveURL(/\/en\/login\?next=/);
});
