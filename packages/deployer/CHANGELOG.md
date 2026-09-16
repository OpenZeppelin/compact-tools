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

- **Breaking:** the deploy stack moves to Ledger v9. `@midnight-ntwrk/compact-runtime` `0.16.0` → `0.19.0`, `@midnight-ntwrk/ledger-v8` `8.1.0` → `@midnightntwrk/ledger-v9` `1.0.0-rc.3`, `@midnight-ntwrk/compact-js` `2.5.1` → `2.5.5-rc.8`, the `midnight-js` packages and `testkit-js` `4.1.1` → `5.0.0-beta.7`, and the wallet-SDK packages to the `@midnightntwrk` scope at `4.0.0-beta.2` / `5.0.0-beta.2`. Artifacts must be compiled with `compact compile +0.34.0`; a 0.31.x artifact fails at submit with `Version mismatch`. See the README's "Supported stack" section (#192)
- **Breaking:** the ledger tags signing and verifying keys with their signature scheme, as `{ tag: 'schnorr', value: <hex> }`. `SigningKey` gains a `ledgerKey` getter returning that form, `ChainSnapshot.committee` is `SignatureVerifyingKey[]` rather than `string[]`, and `verifyingKeyOf` takes and returns tagged keys. The `signing_key_file` on disk is unchanged: still 64 hex chars, no tag (#192)
- yarn and pnpm consumers now need one resolution, `@midnightntwrk/ledger-v9` `1.0.0-rc.3`, instead of the six the v8 stack required. Everything else in that line pins exact versions (#192)
- `proof_server = "auto"` boots `midnightntwrk/proof-server:9.0.0-rc.6`. The repo's integration stack moves to `midnightntwrk/indexer-standalone:4.4.0-rc.2` and `midnightntwrk/midnight-node:2.0.0-rc.4` (#192)
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
