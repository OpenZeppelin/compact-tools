# compact-tools — integration tests

End-to-end tests for `@openzeppelin/compact-deployer` against a real local Midnight stack (proof-server + indexer + node, Docker).

## Layout

```
tests/integrations/
  local-env.yml             # Docker compose: proof-server + indexer + node
  vitest.config.ts          # Vitest config (forks pool, long timeouts)
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

This is **not** a workspace package. The root `package.json` adds `@openzeppelin/compact-deployer` as a dev dep (resolved via yarn workspaces), and the root `test:integration` script invokes vitest pointed at this folder.

## Run

From the repo root (`compact-tools/`):

```bash
make build                                                # build compact-deployer
make test-integration                                     # env-up → compile → test → env-down
```

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
- **deploy** — deploys Counter to the local stack; verifies returned address, txHash, blockHeight, signingKey, and the persisted `deployments/compact/local.json` record.
- **history rotation** — redeploying rotates the previous head into `local.history.json`.
- **proof_server auto** — `proof_server = "auto"` (or `--proof-server auto`) boots a `DynamicProofServerContainer` for the duration of the deploy and disposes it on exit.
- **async-dispose cleanup** — a failure mid-prepare (after the proof server starts) is unwound via `AsyncDisposableStack`; the next deploy still works.
- **wallet lifecycle** — `Deployer.prepare` doesn't call `wallet.stop()` on dispose when `walletProvider` is injected (caller-owned).
- **history isolation** — Counter and SecondaryCounter share an artifact but maintain independent head/history slots per contract name.
- **keystore + passphrase** — `[wallet].keystore` configured in `compact.toml` resolves the seed via the `promptPassphrase` callback; wrong/missing passphrase fails with `WalletError`.
- **PrivateCounter** — exercises the `init_private_state` and `witnesses = { module, export }` resolution paths end-to-end.

## Notes

- Uses the canonical genesis-funded seed `0x…0001` via `[networks.local].wallet = { source = "local", index = 0 }`.
- The CMA signing key in `fixtures/signingkeys/Counter.signingkey` is a fixed test value. Never use it for real deploys.
- The `deployments/` directory is wiped between test runs to keep specs hermetic.
