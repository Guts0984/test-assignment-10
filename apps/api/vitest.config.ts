import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
  esbuild: {
    target: 'es2022',
    tsconfigRaw: {
      compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
    },
  },
});
