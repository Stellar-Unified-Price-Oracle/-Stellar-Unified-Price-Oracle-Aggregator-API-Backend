import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.idea', '.git', '.cache', 'tests/e2e', 'tests/integration'],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'clover'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/routes/admin.ts', 'src/routes/webhooks.ts'],
      thresholds: {
        lines: 32,
        functions: 32,
        branches: 27,
        statements: 33,
      },
    },
  },
});
