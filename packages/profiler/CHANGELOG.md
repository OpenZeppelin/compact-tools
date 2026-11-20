# Changelog

All notable changes to `@openzeppelin/compact-profiler` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `compact-profile` bin, a launcher that downloads the [`compact-profile`](https://github.com/OpenZeppelin/compact-tools/tree/main/crates/compact-profile) release binary for the host, verifies its SHA-256, and runs it
- `createProfiler`, a runner that executes a compiled contract's circuits in memory and writes one unproven transaction per scenario plus the manifest `compact-profile` reads
- `scenario`, `series` and `searchMax`, which finds the largest call count that fits every per-transaction limit of the given networks
- `runCheck`, which runs `compact-profile check` or `update` and rejects on a non-zero exit
