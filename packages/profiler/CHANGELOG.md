# Changelog

All notable changes to `@openzeppelin/compact-profiler` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `compact-profile` bin, a launcher that downloads the [`compact-profile`](https://github.com/OpenZeppelin/compact-tools/tree/main/crates/compact-profile) release binary for the host, verifies its SHA-256, and runs it
- The `compact-profile` binary, a capacity profiler for Compact contract transactions: `params`, `cost`, `check` and `update`
- `cost` reads unproven, proven and wallet-balanced transactions; a balanced one is evaluated as submitted
- Shipped profiles for `mainnet`, `preprod` and `undeployed` (node 2.1.101, `midnight-ledger-v9` 1.0.1) with node caps and a balancing term measured on a 2.1.101 dev chain
- The weight model counts frame_system's base extrinsic weight in the block total, not against the per-extrinsic ceiling
- Optional profile section `[proof]`: bytes proving adds per contract call proof (`call_bytes`) and per Zswap or Dust proof (`builtin_bytes`) beyond the ledger's size estimate; every shipped profile carries 564 and 2, measured on a 2.1.101 dev chain
- An unproven transaction's estimated size and `blockUsage` include the proof term, counted from its proofs; a proven or balanced one gets none. `cost` and `check` report it as `proofTerm` in JSON, and the tables show it
- Optional manifest field `ops` for logical operations per transaction; the report and snapshot count `opsPerBlock`
- Optional profile field `min_client_ledger` (`1.0.2` on every shipped profile); `check` and `update` warn and label a network when the manifest's `@midnightntwrk/ledger-v9` is older
- `params --reporter json`
- `check` allows 32 bytes of drift on `serializedLen` and `blockUsage`, which vary between builds of one scenario; `--size-tolerance` changes it
- `createProfiler`, a runner that executes a compiled contract's circuits in memory and writes one unproven transaction per scenario plus the manifest `compact-profile` reads
- `scenario`, `series` and `searchMax`, which finds the largest call count that fits every per-transaction limit of the given networks
- `runCheck`, which runs `compact-profile check` or `update` and rejects on a non-zero exit
