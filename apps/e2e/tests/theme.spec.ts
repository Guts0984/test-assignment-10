import { expect, test } from '@playwright/test';
import { BASE } from './helpers';

const bg = (page: import('@playwright/test').Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe('theme', () => {
  test.use({ colorScheme: 'dark' });
  test('follows the OS by default, then the explicit choice wins and survives a reload', async ({
    page,
  }) => {
    await page.goto(`${BASE}/en`);
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await bg(page)).toBe('rgb(11, 17, 32)');

    await page.getByRole('button', { name: 'Light' }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    expect(await bg(page)).toBe('rgb(255, 255, 255)');

    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/dark/); // remembered, OS is still dark
    await expect(page.getByRole('button', { name: 'Light' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('no white flash: the class is set before the page is hydrated', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('shop-theme', 'dark'));
    await page.route('**/_next/static/**', (r) => r.abort()); // no JS bundles at all
    await page.goto(`${BASE}/en`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveClass(/dark/);
  });
});
