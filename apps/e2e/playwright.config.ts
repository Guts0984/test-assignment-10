import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against the REAL composed stack (nginx -> web/api -> postgres, seeded), default http://localhost:8080.
 * One worker: the tests share one database, and each test uses its own seeded customer.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    ...devices['Desktop Chrome'],
  },
});
