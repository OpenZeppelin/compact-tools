# Changelog

All notable changes to `@openzeppelin/compact-profiler` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `compact-profile` bin, a launcher that downloads the [`compact-profile`](https://github.com/OpenZeppelin/compact-tools/tree/main/crates/compact-profile) release binary for the host, verifies its SHA-256, and runs it (#239)
- `@openzeppelin/compact-launcher` dependency, which downloads, verifies and caches the binary for the bin and `resolveProfileBinary` (#239)
- The `compact-profile` binary, a capacity profiler for Compact contract transactions: `params`, `cost`, `check` and `update` (#239)
- `cost` reads unproven, proven and wallet-balanced transactions; a balanced one is evaluated as submitted (#239)
- Shipped profiles for `mainnet`, `preprod` and `undeployed` (node 2.1.101, `midnight-ledger-v9` 1.0.1) with node caps and a balancing term measured on a 2.1.101 dev chain (#239)
- The weight model counts frame_system's base extrinsic weight in the block total, not against the per-extrinsic ceiling (#239)
- Optional profile section `[proof]`: bytes proving adds per contract call proof (`call_bytes`) and per Zswap or Dust proof (`builtin_bytes`) beyond the ledger's size estimate; every shipped profile carries 564 and 2, measured on a 2.1.101 dev chain (#239)
- An unproven transaction's estimated size and `blockUsage` include the proof term, counted from its proofs; a proven or balanced one gets none. `cost` and `check` report it as `proofTerm` in JSON, `costTransaction` returns it, and the tables show it (#239)
- `[balancing]` field `further_intent_bytes`, required with the others: bytes each intent after the first adds when balanced, counted from the transaction's intents; every shipped profile carries 65. `cost` and `check` report the intents and the bytes added as `balancingTerm` in JSON, and the tables show them (#239)
- Optional manifest field `ops` for logical operations per transaction; the report and snapshot count `opsPerBlock` (#239)
- Optional profile field `min_client_ledger` (`1.0.2` on every shipped profile); `check` and `update` warn and label a network when the manifest's `@midnightntwrk/ledger-v9` is older (#239)
- `params --reporter json` (#239)
- `check` allows 32 bytes of drift on `serializedLen` and `blockUsage`, which vary between builds of one scenario; `--size-tolerance` changes it (#239)
- The `blockLength` limit counts the encoded extrinsic that carries the balanced transaction, in its `used`, its per-block bound and its series prediction (#239)
- Parity compares the manifest's `calls` with the transaction's contract calls; a mismatch fails `check` and stops `update` (#239)
- A series' `timeToDismiss` prediction is `unbounded` when time to dismiss rises slower than its per-byte allowance (#239)
- A series' `maxN` stays below the smallest size measured to fail, and `basis` is then `measured` (#239)
- `createProfiler`, a runner that executes a compiled contract's circuits in memory and writes one unproven transaction per scenario plus the manifest `compact-profile` reads (#239)
- `scenario`, `series` and `searchMax`, which finds the largest call count that fits every per-transaction limit of the given networks (#239)
- `runCheck`, which runs `compact-profile check` or `update` and rejects on a non-zero exit (#239)
- The cached `compact-profile` binary is verified against the package's `checksums.txt` every time the bin or the library resolves it, and downloaded again when it does not match or is not a regular file (#239)
- Each call runs on a `structuredClone` of the private state, so a witness that changes it in place leaves the base state alone; `privateState` must be structured-cloneable (#239)
- `searchMax` rejects an empty `networks` (#239)
- A call's shielded outputs all reach the transaction when two share type, nonce and value; a spent coin pairs only with an unspent contract-owned output (#239)
