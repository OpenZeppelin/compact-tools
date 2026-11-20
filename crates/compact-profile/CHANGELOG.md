# Changelog

All notable changes to `compact-profile` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this crate adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `compact-profile`, a capacity profiler for Compact contract transactions: `params`, `cost`, `check` and `update`
- `cost` reads unproven, proven and wallet-balanced transactions; a balanced one is evaluated as submitted
- Shipped profiles for `mainnet` and `preprod` (node 2.1.101, `midnight-ledger-v9` 1.0.1) with node caps and a balancing term measured on a 2.1.101 dev chain, and a provisional `undeployed`
- The weight model counts frame_system's base extrinsic weight in the block total, not against the per-extrinsic ceiling
- Optional manifest field `ops` for logical operations per transaction; the report and snapshot count `opsPerBlock`
- Optional profile field `min_client_ledger` (`1.0.2` on `mainnet` and `preprod`); `check` and `update` warn and label a network when the manifest's `@midnightntwrk/ledger-v9` is older
- `params --reporter json`
