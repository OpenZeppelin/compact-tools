# Changelog

All notable changes to `@openzeppelin/compact-deployer` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Fragmented deploy for contracts too large for one block, driven by `--circuits-per-tx` / `[contracts.X].circuits_per_tx`, with resume from chain state and a strict verify before `confirmed`. See the README's "Large contracts" section
- `DeployResult` gains `fragments` and `circuits`; both appear in `--json`, alongside a failed fragmented deploy's `address`, `circuitsOnChain`, `circuitsPending`, and `txId`
- Exit codes `7` (`BlockLimitError`: the deploy tx was refused as too large at the configured or minimum fragment size) and `8` (`FragmentDeployError`: fragmented deploy incomplete and resumable)

### Changed

- `DeploymentRecord` gains a `partial` member. A single-tx deploy still writes only `pending` then `confirmed`, so an exhaustive `switch` on `status` needs a new arm only if it reads records from a split deploy
- A deploy that fits one transaction is unchanged: same transaction, same `pending` then `confirmed` records, no chain read and no maintenance transaction

## 0.1.0 (2026-09-09)

### Fixed

- `@midnight-ntwrk/ledger-v8` is pinned to 8.1.0, the exact version `midnight-js-protocol` 4.1.1 requires, so an npm install of the package holds one ledger copy. With 8.1.2 a second copy was nested and every deploy failed with `expected instance of DustParameters`. yarn and pnpm users add the resolutions listed in the README's "Supported stack" section (#171)

### Added

- Initial package. `Deployer` and `runDeploy` build and submit a Compact deploy transaction from a `compact.toml` profile, resolving the artifact, constructor args, initial private state, and contract signing key, then record the result in `<deployments_dir>/<network>.json` (#86)
- Wallet support: seed-file / `MN_DEPLOYER_SEED` / keystore / prefunded-local seed resolution, a per-seed on-disk sync cache under `.states/`, and a `proof_server = "auto"` mode that boots a testkit-js proof-server container for the run (#86)
- Supported deploy stack is `@midnight-ntwrk/compact-runtime` 0.16.0 and `@midnight-ntwrk/ledger-v8` 8.1.0; artifacts must be compiled with `compact compile +0.31.1`. See the README's "Supported stack" section (#86)
- A packaged `proof-server.yml`, pinning `midnightntwrk/proof-server:8.0.3`, is what `proof_server = "auto"` boots. `auto` no longer depends on a compose file in the working directory, though one there still wins (#165)
