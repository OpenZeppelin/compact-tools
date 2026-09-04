# Changelog

All notable changes to `@openzeppelin/compact-deployer` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Initial package. `Deployer` and `runDeploy` build and submit a Compact deploy transaction from a `compact.toml` profile, resolving the artifact, constructor args, initial private state, and contract signing key, then record the result in `<deployments_dir>/<network>.json` (#86)
- Wallet support: seed-file / `MN_DEPLOYER_SEED` / keystore / prefunded-local seed resolution, a per-seed on-disk sync cache under `.states/`, and a `proof_server = "auto"` mode that boots a testkit-js proof-server container for the run (#86)
- Supported deploy stack is `@midnight-ntwrk/compact-runtime` 0.16.0 and `@midnight-ntwrk/ledger-v8` 8.1.2; artifacts must be compiled with `compact compile +0.31.1`. See the README's "Supported stack" section (#86)
