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
      include: ['src/**/*.ts'],
      // The bin runs in a subprocess, which v8 coverage does not observe.
      exclude: ['src/compactLinter.ts'],
    },
  },
});
