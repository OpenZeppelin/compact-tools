# compact-tools — integration tests

End-to-end tests for `@openzeppelin/compact-deploy` against a real local Midnight stack (proof-server + indexer + node, Docker).

## Layout

```
tests/integrations/
  local-env.yml             # Docker compose: proof-server + indexer + node
  Makefile                  # env-up, env-down, compile
  vitest.config.ts          # Vitest config (forks pool, long timeouts)
  compact.toml              # Deployer config; paths resolve to this dir
  fixtures/
    Counter.compact         # Minimal one-circuit fixture
    signingkeys/
      Counter.signingkey    # CMA signing key (test-only)
    artifacts/              # Output of compact-compiler (gitignored)
  deploy.local.spec.ts      # Specs: dry-run, deploy, history rotation
```

This is **not** a workspace package. The root `package.json` adds `@openzeppelin/compact-deploy` as a dev dep (resolved via yarn workspaces), and the root `test:integration` script invokes vitest pointed at this folder.

## Run

From the repo root (`compact-tools/`):

```bash
corepack yarn build                                       # build compact-deploy
make -C tests/integrations env-up                         # start docker stack
make -C tests/integrations compile                        # compile Counter.compact
corepack yarn test:integration                            # run specs
make -C tests/integrations env-down                       # stop stack
```

Or all-in-one with the root aliases:

```bash
corepack yarn env:up
make -C tests/integrations compile
corepack yarn test:integration
corepack yarn env:down
```

## What's covered

- **dry-run** — loads + validates the config without submitting a tx.
- **deploy** — deploys Counter to the local stack; verifies returned address, txHash, blockHeight, signingKey, and the persisted `deployments/compact/local.json` record.
- **history rotation** — redeploying rotates the previous head into `local.history.json`.

## Notes

- Uses the canonical genesis-funded seed `0x…0001` via `[networks.local].wallet = { source = "local", index = 0 }`.
- The CMA signing key in `fixtures/signingkeys/Counter.signingkey` is a fixed test value. Never use it for real deploys.
- The `deployments/` directory is wiped between test runs to keep specs hermetic.
