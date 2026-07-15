import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'clover'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 30,
        functions: 40,
        branches: 25,
        statements: 30,
      },
    },
  },
});
