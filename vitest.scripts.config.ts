import { defineConfig } from 'vitest/config';

// The repo-level release helpers are not a workspace, so turbo's per-package
// `test` task does not reach them. `yarn test:scripts` runs them.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/test/**/*.test.mjs'],
    reporters: 'verbose',
  },
});
