import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ['specs/**/*.spec.ts'],
    testTimeout: 240_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    globalSetup: ['./_harness/teardown.ts'],
  },
});
