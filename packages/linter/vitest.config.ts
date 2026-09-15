import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: 'verbose',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // The bin runs in a subprocess, which v8 coverage does not observe.
      include: ['src/binary.ts'],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 100,
        lines: 95,
      },
    },
  },
});
