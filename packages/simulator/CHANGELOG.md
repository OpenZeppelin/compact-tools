# Changelog

All notable changes to `@openzeppelin/compact-simulator` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases before `0.4.0` predate this file; see the `compact-simulator/v*` tags.

## Unreleased

### Added

- `BaseSimulatorOptions.time` sets the block time the kernel's time operations observe, in seconds since the epoch. Defaults to `0` for reproducible runs (#147)

### Changed

- **Breaking:** `@midnight-ntwrk/compact-runtime` moves to `0.19.0`, which made `initialState` and every circuit async. The `@midnight-ntwrk/midnight-js-contracts` and `@midnight-ntwrk/midnight-js-types` peers move from `^4.1.0` to `^5.0.0-beta.7`. Both peers stay optional, so a dry-only consumer needs neither (#152)
- **Breaking:** construction is async. Replace `new MySimulator(args, options)` with `await MySimulator.create(args, options)`. Subclass `create` overrides return `Promise<MySimulator>` and delegate to `super._create([...args], options)` (#145, #147)
- **Breaking:** circuit proxies return promises. `ContextlessCircuits` maps to `Promise<R>`, so an un-awaited call that used to pass as a truthy promise, such as `if (sim.isOwner(x))`, no longer typechecks (#145, #154)
- **Breaking:** `getPrivateState()`, `getPublicState()`, and `getContractState()` return promises (#145)
- **Breaking:** `CircuitContextManager`'s constructor takes `time`, as `(contract, privateState, coinPK, contractAddress, time, ...contractArgs)`, and `init()` must be awaited once before any circuit call. Direct users of `CircuitContextManager` or `AbstractSimulator` are affected; the `createSimulator` path awaits `init()` internally (#147)
- **Breaking:** `CircuitContext` nests its runtime state under `callContext`, e.g. `ctx.callContext.currentPrivateState` and `ctx.callContext.currentQueryContext.state.state` (#145)
- **Breaking:** live pure circuits bind to the deployed address. An explicit `contractAddress` that differs from the deployed one is rejected rather than silently used for local pure evaluation (#154)
