import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: 'verbose',
    globalSetup: ['./test/setup.ts'],
    // End-to-end runs build transactions of up to a few hundred calls.
    testTimeout: 300_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      // The bin runs in a subprocess, which v8 coverage does not observe.
      include: ['src/**/*.ts'],
      exclude: ['src/compactProfile.ts', 'src/index.ts'],
    },
  },
});
