# Changelog

All notable changes to `@openzeppelin/compact-simulator` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Initial public release of `@openzeppelin/compact-simulator`.
- `createSimulator` factory for building type-safe per-contract simulator
  classes, with configurable private state, ledger extractor, witnesses and
  contract constructor arguments.
- Core building blocks: `AbstractSimulator`, `ContractSimulator`,
  `CircuitContextManager` for managing private state, public (ledger) state,
  zswap local state and transaction context.
- Public types: `IContractSimulator`, `IMinimalContract`,
  `ExtractPureCircuits`, `ExtractImpureCircuits`, `ContextlessCircuits`,
  `BaseSimulatorOptions`, `SimulatorConfig`.
- Toolchain pin: `@midnight-ntwrk/compact-runtime` 0.14.0 (Compact compiler
  0.29.0 generation) and `@midnight-ntwrk/ledger-v7`.
