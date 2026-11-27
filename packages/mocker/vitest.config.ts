import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: 'verbose',
    globalSetup: ['./test/setup.ts'],
    // The command cases compile mocks and run compact-compiler on a temp copy.
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.ts'],
      // The bin runs in a subprocess, which v8 coverage does not observe.
      exclude: ['src/compactMock.ts'],
    },
  },
});
