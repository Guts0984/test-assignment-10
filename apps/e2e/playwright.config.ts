import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against the REAL composed stack (nginx -> web/api -> postgres, seeded) - but never against
 * the one you develop on: these tests create products, orders and payments. Use `pnpm test:stack`,
 * which starts a throwaway stack on its own ports and database and passes E2E_BASE_URL.
 * One worker: the tests share one database, and each test uses its own seeded customer.
 */
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) {
  throw new Error(
    'E2E_BASE_URL is not set. Run the suite with `pnpm test:stack` (throwaway stack), ' +
      'or set E2E_BASE_URL to a stack you are happy to fill with test data.',
  );
}

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    ...devices['Desktop Chrome'],
  },
});
