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
    // One forked worker, files run in sequence, module state kept between
    // them: that is what lets `_harness/walletPool.ts` hand the same warm
    // wallet to every spec instead of re-syncing per file. Wallets are
    // released when that worker exits — a `globalSetup` teardown runs in
    // the main process and would never see the pool.
    pool: 'forks',
    fileParallelism: false,
    isolate: false,
  },
});
