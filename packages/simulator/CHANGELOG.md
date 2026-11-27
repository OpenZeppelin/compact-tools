# Changelog

All notable changes to `@openzeppelin/compact-simulator` are documented in this
file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases before `0.4.0` predate this file; see the `compact-simulator/v*` tags.

## Unreleased

### Added

- Each `createSimulator` instance has one async method per circuit, named after it, that calls the circuit through `circuits`. A name the instance already has (a base member, a subclass method, an `Object.prototype` member) keeps its own, and `then` is never installed (#248)
- `flatCircuits: true` in the config types those methods on the returned class, so a subclass needs no forwarding methods. Without it the class type is unchanged (#248)
- Type exports `FlatCircuits`, `FlatSimulatorClass`, `FlatSimulatorInstance` and `SimulatorClass` (#248)
- `defineSimulator(artifact, definition?)` builds a simulator class from a compiled contract module, with no config generics, `create` override or forwarding methods. Every circuit is an async method, every pure circuit also a synchronous static method, and `create(...constructorArgs, options?)` takes the constructor arguments positionally, with the arity read from the compiled contract. The options slot takes an options object or `undefined` only (#248)
- A definition's witnesses are checked against the contract's `Witnesses<P>`, with the private state `P` the definition yields: a missing witness, a wrong value type or a private-state mismatch fails to compile. A contract with witnesses needs a definition with `witnesses` set, not `undefined`, unless `prepare` supplies them (#248)
- A definition's `witnesses` and `privateState` take a list of factories, merged into one, e.g. a module's and its authenticator's. A part's witness may return only its own part of the private state; the merged witness writes it over the whole state. A part may be a class instance. A witness or private-state key two parts define throws when the definition runs. `composeWitnesses` and `composePrivateState` return the merged factory, with its `parts`, and type-check as a contract's `Witnesses<P>` in `createSimulator` (#248)
- A definition's `extend` adds members to every instance, replacing circuit methods of the same name, and `prepare` maps `create`'s own arguments to the constructor arguments, the options and instance fields. Neither takes a base member name, an `Object.prototype` name or `then`, and accessors stay accessors. A function `extend` adds in place of a circuit method spends the `as()` caller like the circuit. Other `extend` members do not spend it, like subclass methods. A class with `prepare` has no `_create` (#248)
- Type exports `ArtifactContract`, `ArtifactLedger`, `ArtifactWitnesses`, `Composed`, `ComposedFactory`, `ComposedWitness`, `ComposedWitnesses`, `ConstructorArgs`, `ContractArtifact`, `DefinedPrivateState`, `DefinedSimulatorClass`, `DefinedSimulatorInstance`, `DefinedWitnesses`, `PartFactory`, `Parts`, `PositionalInput`, `PreparedCreate`, `PreparedSimulatorClass`, `PrivateStateAccess`, `PureCircuitStatics`, `ReservedFlatName`, `ReservedStaticName`, `SimulatorDefinition` and `SimulatorInstance` (#248)

### Changed

- **Breaking:** `Backend` has `consumeSingleCaller()`, which clears the `as()` caller for a call that does not reach the backend. `DryBackend` and `LiveBackend` implement it. A `Backend` implemented outside this package must add it (#248)

### Fixed

- `as()`, `setPersistentCaller()` and `resetCaller()` return the instance type in the published declarations, so a call chained after them is type-checked. `SimulatorClass` and `SimulatorInstance` are declared interfaces (#248)
- `as()` applies to one call only. A failed call spends it too, on both backends, and on dry a successful call no longer leaves the `as()` caller in the stored circuit context. The next call runs as the persistent or default caller (#248)

## 0.6.0 (2026-11-16)

### Changed (breaking)

- The live peers move to `@midnight-ntwrk/midnight-js-contracts` and `@midnight-ntwrk/midnight-js-types` `^5.0.0`. `createLiveContext` decodes the contract state the public data provider now returns as bytes, and reads and writes private state through `privateStateProvider.forContract(contractAddress)`, so a live harness has to hand it 5.0.0 providers (#219)

## 0.5.0 (2026-11-05)

### Changed

- **Breaking:** `@midnight-ntwrk/compact-runtime` moves to `0.21.0`. Compile artifacts with compactc `0.36.0`. Generated code checks the runtime version at load, so an older artifact throws `Version mismatch` when it loads (#208)
- **Breaking:** `@midnight-ntwrk/compact-runtime` is a peer dependency, `^0.21.0`. Install it in your project; the simulator and your compiled contracts must share one copy, so a consumer that forced another version through `resolutions` has to drop that entry (#209)

## 0.4.1 (2026-09-25)

### Added

- `CreateLiveContextOptions.scopedTransactionOptions` runs every live call in a midnight-js scoped transaction with those options. With `additionalCoinEncPublicKeyMappings`, a circuit can send a shielded coin to a wallet other than the caller (#195)

## 0.4.0 (2026-09-01)

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
