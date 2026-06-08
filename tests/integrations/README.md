# compact-tools — integration tests

End-to-end tests for `@openzeppelin/compact-deployer` against a real local Midnight stack (proof-server + indexer + node, Docker).

## Layout

```
tests/integrations/
  local-env.yml             # Docker compose: proof-server + indexer + node
  vitest.config.ts          # Vitest config (one forked worker, long timeouts)
  tsconfig.json             # Type-check config; run by the root `yarn types`
  package.json              # Marks the tree as ESM; not a workspace member
  compact.toml              # Deployer config; paths resolve to this dir
  _harness/                 # Shared setup: walletPool, network, paths, …
  fixtures/
    Counter.compact         # Minimal one-circuit fixture
    PrivateCounter.compact  # Witness + private-state fixture
    signingkeys/            # Per-contract CMA keys (test-only)
    initstates/             # init_private_state JSON seeds
    witnesses/              # TS witness modules (resolved at deploy time)
    artifacts/              # Output of compact-compiler (gitignored)
  specs/
    deploy/                 # deploy, dry-run, history rotation/isolation,
                            #   proof-server auto, async-dispose, PrivateCounter
    wallet/                 # wallet pool, lifecycle, keystore+passphrase
    errors/                 # config-error surface
```

All orchestration (env-up / env-down / compile / test-integration) lives in
the top-level `/Makefile`; this directory holds only the test sources,
fixtures, and config.

This is **not** a workspace package. Its `package.json` only marks the tree
as ESM. Everything it imports (`@openzeppelin/compact-deployer`,
`@midnight-ntwrk/testkit-js`, `vitest`, `pino`) is declared in the root
`package.json` dev deps, and the root `test:integration` script invokes vitest
pointed at this folder. The root `yarn types` type-checks these sources via
`tests/integrations/tsconfig.json`.

## Run

From the repo root (`compact-tools/`):

```bash
make build                                                # build compact-deployer
make test-integration                                     # env-up → compile → test → env-down
```

Fixtures are compiled with `compact compile +0.31.1`. The deployer pins
compact-runtime 0.16.0, and an artifact from the default compactc (0.34.x)
fails at submit with a `Version mismatch`. See "Supported stack" in
[`packages/deployer/README.md`](../../packages/deployer/README.md).

`make test-integration` is fully self-contained: it brings the docker
stack up, compiles the fixture contracts, runs the specs, and tears the
stack down at the end. Teardown is wired via a `trap … EXIT INT TERM`
inside the Makefile recipe so it fires even when the tests fail or
you `Ctrl+C` out.

`yarn test:integration` is kept as a thin wrapper around the same
Make target so the CI invocation surface stays consistent with the
other yarn scripts.

### Iterative dev (skip the up/down cycle)

For fast inner-loop work (editing a spec and re-running) the up/down
dance is wasted time. Bring the stack up once, then call vitest
directly:

```bash
make env-up                                               # one-time
make compile                                              # idempotent; no-op if sources unchanged
yarn vitest run --config tests/integrations/vitest.config.ts
make env-down                                             # when you're done iterating
```

## What's covered

- **dry-run** — loads + validates the config without submitting a tx.
- **deploy** — deploys Counter to the local stack; asserts the exact `DeployResult` shape and the exact `status: "confirmed"` record persisted at `deployments/compact/local.json`.
- **history rotation** — redeploying rotates the previous head into `local.history.json`.
- **proof_server auto** (skipped) — `proof_server = "auto"` boots a `DynamicProofServerContainer` for the duration of the deploy and disposes it on exit. Skipped: testkit-js boots that container from `<cwd>/proof-server.yml`, which the repo does not ship.
- **async-dispose cleanup** (skipped) — a failure mid-prepare (after the proof server starts) is unwound via `AsyncDisposableStack`; the next deploy still works. Skipped for the same reason.
- **wallet lifecycle** — `Deployer.prepare` doesn't call `wallet.stop()` on dispose when `walletProvider` is injected (caller-owned).
- **history isolation** — Counter and SecondaryCounter share an artifact but maintain independent head/history slots per contract name.
- **keystore + passphrase** — `[wallet].keystore` configured in `compact.toml` resolves the seed via the `promptPassphrase` callback; wrong/missing passphrase fails with `WalletError`.
- **PrivateCounter** — exercises the `init_private_state` and `witnesses = { module, export }` resolution paths end-to-end.

## Notes

- Specs inject their wallet through `walletProvider`, taken from the shared pool in `_harness/walletPool.ts` (the dev preset's genesis accounts: `TEST_MNEMONIC` plus hex seeds `0x…0001`–`0x…0004`). `[networks.local].wallet = { source = "local", index = 0 }` in `compact.toml` is there for a manual `compact-deploy --config tests/integrations/compact.toml` run; no spec goes through it.
- Pool wallets are built with `skipWalletCache`, since `make env-down` wipes the chain and a stale `.states/` snapshot would restore UTXOs that no longer exist.
- The CMA signing key in `fixtures/signingkeys/Counter.signingkey` is a fixed test value. Never use it for real deploys.
- The `deployments/` directory is wiped between test runs to keep specs hermetic. It, `fixtures/artifacts/`, and `logs/` are covered by the repo-root `.gitignore`.
