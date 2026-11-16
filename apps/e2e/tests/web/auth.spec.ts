import { expect, test, type Page } from '@playwright/test';
import { BASE, customer, loginAs, MANAGER, uiLogin, uuid } from '../helpers';

const email = (p: Page) => p.getByLabel('E-mail');
const password = (p: Page) => p.getByLabel('Password');
const signIn = (p: Page) => p.getByRole('button', { name: 'Sign in' });

test.describe('login form', () => {
  test('empty and malformed input is explained next to the fields and NOTHING is sent', async ({
    page,
  }) => {
    const sent: string[] = [];
    page.on('request', (r) => r.url().includes('/api/auth/login') && sent.push(r.url()));
    await page.goto('/en/login');
    await signIn(page).click();
    await expect(page.getByText('This field is required')).toHaveCount(2);
    await email(page).fill('not-an-email');
    await password(page).fill('x');
    await signIn(page).click();
    await expect(page.getByText('Enter a valid e-mail address')).toBeVisible();
    expect(sent).toHaveLength(0);
  });

  test('a wrong password and an unknown e-mail get the SAME message (no account enumeration) and stay on the page', async ({
    page,
  }) => {
    await page.goto('/en/login');
    await email(page).fill(customer(10).email);
    await password(page).fill('Wrong-Password-1');
    await signIn(page).click();
    const known = await page.getByText('Wrong e-mail or password.').textContent();
    await email(page).fill('nobody-at-all@shop.test');
    await signIn(page).click();
    await expect(page.getByText('Wrong e-mail or password.')).toBeVisible();
    expect(known).toBe('Wrong e-mail or password.');
    await expect(page).toHaveURL(/\/en\/login/);
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  });

  test('pressing Enter in the password field signs in (keyboard shortcut) and the header changes', async ({
    page,
  }) => {
    await page.goto('/en/login');
    await email(page).fill(customer(10).email);
    await password(page).fill(customer(10).password);
    await password(page).press('Enter');
    await expect(page).toHaveURL(/\/en\/?$/);
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByText(customer(10).email)).toBeVisible();
  });

  test('after 5 wrong passwords the 6th attempt is refused with a wait time - and the right password is refused too', async ({
    page,
  }) => {
    const victim = customer(11);
    await page.goto('/en/login');
    await email(page).fill(victim.email);
    await password(page).fill('Wrong-Password-0');
    await signIn(page).click();
    const first = await Promise.race([
      page
        .getByText('Wrong e-mail or password.')
        .waitFor()
        .then(() => 'wrong'),
      page
        .getByText(/Too many attempts/)
        .waitFor()
        .then(() => 'locked'),
    ]);
    test.skip(
      first === 'locked',
      'customer11 is still locked by an earlier run: use a fresh stack',
    );
    for (let i = 1; i < 5; i++) {
      await password(page).fill(`Wrong-Password-${i}`);
      await signIn(page).click();
      await expect(page.getByText('Wrong e-mail or password.')).toBeVisible();
    }
    await password(page).fill('Wrong-Password-5');
    await signIn(page).click();
    await expect(page.getByText(/Too many attempts\. Try again in \d+ seconds?\./)).toBeVisible();
    await password(page).fill(victim.password);
    await signIn(page).click();
    await expect(page.getByText(/Too many attempts/)).toBeVisible();
    await expect(page).toHaveURL(/\/en\/login/);
  });
});

test.describe('where you land after signing in', () => {
  test('?next=/en/orders (with the language) works like ?next=/orders - no /en/en/... 404', async ({
    page,
  }) => {
    await page.goto('/en/login?next=%2Fen%2Forders');
    await email(page).fill(customer(12).email);
    await password(page).fill(customer(12).password);
    await signIn(page).click();
    await expect(page).toHaveURL(/\/en\/orders$/);
    await expect(page.getByRole('heading', { name: 'My orders' })).toBeVisible();
  });

  test('a protected page sends a visitor to the login and back to that page afterwards', async ({
    page,
  }) => {
    await page.goto('/en/orders');
    await expect(page).toHaveURL(/\/en\/login\?next=%2Forders/);
    await email(page).fill(customer(12).email);
    await password(page).fill(customer(12).password);
    await signIn(page).click();
    await expect(page).toHaveURL(/\/en\/orders$/);
    await expect(page.getByRole('heading', { name: 'My orders' })).toBeVisible();
  });

  for (const evil of [
    'https://evil.example/steal',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '%2F%2Fevil.example',
    '/en/login', // the login page itself is no destination
    '/login',
    '/en//evil.example',
  ]) {
    test(`?next=${evil} never leaves the shop`, async ({ browser }) => {
      const ctx = await browser.newContext({ baseURL: BASE });
      const page = await ctx.newPage();
      await page.goto(`/en/login?next=${encodeURIComponent(evil)}`);
      await email(page).fill(customer(12).email);
      await password(page).fill(customer(12).password);
      await signIn(page).click();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      // "Sign out" appears while the redirect is still running: wait until the login page is left
      await expect(page).not.toHaveURL(/\/login/);
      const url = new URL(page.url());
      expect(url.origin).toBe(new URL(BASE).origin);
      expect(url.pathname).not.toMatch(/\/login\/?$/); // not bounced back into the login page either
      await ctx.close();
    });
  }
});

test.describe('who may open which page', () => {
  const protectedPaths = [
    '/cart',
    '/checkout',
    '/orders',
    `/orders/${uuid()}`,
    '/manager/products',
    '/manager/orders',
    '/manager/promos',
    '/manager/reports',
  ];
  test('a visitor is sent to the login from every protected page (and the page is remembered)', async ({
    page,
  }) => {
    for (const path of protectedPaths) {
      await page.goto(`/en${path}`);
      await expect(page, path).toHaveURL(
        new RegExp(
          `/en/login\\?next=${encodeURIComponent(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ),
      );
    }
  });

  test('a customer sees "no access" on every manager page and no manager links in the header', async ({
    page,
  }) => {
    await loginAs(page, customer(12));
    for (const path of [
      '/manager/products',
      '/manager/orders',
      '/manager/promos',
      '/manager/reports',
    ]) {
      await page.goto(`/en${path}`);
      await expect(page.getByText('You do not have access to this page.'), path).toBeVisible();
    }
    await page.goto('/en');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: 'Cart' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Promo codes' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Sales' })).toHaveCount(0);
  });

  test('the manager has manager links, no cart and no "My orders"; the customer pages say "no access"', async ({
    page,
  }) => {
    await loginAs(page, MANAGER);
    await page.goto('/en');
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    for (const name of ['Products', 'Orders', 'Promo codes', 'Sales'])
      await expect(nav.getByRole('link', { name })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Cart' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'My orders' })).toHaveCount(0);
    await page.goto('/en/cart');
    await expect(page.getByText('You do not have access to this page.')).toBeVisible();
  });
});

test.describe('signing out', () => {
  test('after "Sign out" the protected pages are closed again, in this tab AND in another one', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ baseURL: BASE });
    const a = await ctx.newPage();
    await uiLogin(a, customer(12));
    const b = await ctx.newPage();
    await b.goto('/en/orders');
    await expect(b.getByRole('heading', { name: 'My orders' })).toBeVisible();

    await a.getByRole('button', { name: 'Sign out' }).click();
    await expect(a.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await a.goto('/en/cart');
    await expect(a).toHaveURL(/\/en\/login/);

    await b.reload(); // the other tab shares the (now dead) session
    await expect(b).toHaveURL(/\/en\/login/);
    await ctx.close();
  });

  test('the session cookie is HttpOnly (page scripts cannot read it) and SameSite=Lax', async ({
    page,
  }) => {
    await uiLogin(page, customer(12));
    const sid = (await page.context().cookies()).find((c) => c.name === 'sid');
    expect(sid?.httpOnly).toBe(true);
    expect(sid?.sameSite).toBe('Lax');
    expect(await page.evaluate(() => document.cookie)).not.toContain('sid');
  });
});

test.describe('keyboard and routing basics', () => {
  test('Tab goes to "Skip to content" first; Enter on it moves focus to the main area', async ({
    page,
  }) => {
    await page.goto('/en');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
  });

  test('"/" opens the language of the browser (default Ukrainian); unknown languages and pages show the not-found page', async ({
    browser,
  }) => {
    for (const [browserLocale, expected] of [
      ['uk-UA', 'uk'],
      ['en-US', 'en'],
      ['fr-FR', 'uk'], // not offered: the default language
    ] as const) {
      const ctx = await browser.newContext({ baseURL: BASE, locale: browserLocale });
      const page = await ctx.newPage();
      await page.goto('/');
      await expect(page, browserLocale).toHaveURL(new RegExp(`/${expected}/?$`));
      await ctx.close();
    }
    const ctx = await browser.newContext({ baseURL: BASE, locale: 'en-US' });
    const page = await ctx.newPage();
    await page.goto('/xx');
    // /xx is not a language: it is treated as a path under the visitor's own language -> the app's not-found page
    await expect(page.getByText('Page not found')).toBeVisible();
    await page.goto('/en/this/page/does/not/exist');
    await expect(page.getByText('Page not found')).toBeVisible();
    await ctx.close();
  });
});
