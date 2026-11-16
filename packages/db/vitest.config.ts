import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // each test file gets its own freshly created database, files can run in parallel
    pool: 'forks',
  },
});
