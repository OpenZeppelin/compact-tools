---
stage: design
project: simulator-live-backend
mode: extension
extends: packages/simulator
status: draft
timestamp: 2026-06-22
author: 0xisk
previous_stage: null
tags: [simulator, testing, live-backend, midnight-js, async, tooling]
---

# Simulator Live-Mode Backend — Design Document

> Tracks OpenZeppelin/compact-tools#75. This is a **tooling** design (a TypeScript
> test harness), not a Compact contract. The `midnight-design` skill's
> contract-centric sections (ledger schema, disclosure boundary, witnesses) were
> re-mapped to tooling concerns; see the table in the Summary.

## Summary

Make the per-module simulator class the single test-facing API for a contract, runnable
against either the existing in-memory path (`DryBackend`) or a live local Midnight node
(`LiveBackend<C>`), selected by `MIDNIGHT_BACKEND=dry|live` at fixture-construction time.
A new `createBackendSimulator(...)` factory lives alongside the existing synchronous
`createSimulator(...)`; modules opt in one at a time. The core trade-off: live infra is
async by physics, so a single spec file can run on both backends only if it is written
async. Opted-in modules take a one-time, mostly-mechanical async migration; un-migrated
modules are untouched.

Skill-section re-mapping used in this design:

| Skill section (contracts) | Re-mapped to (tooling) |
|---|---|
| Contract Layout | Package & dependency layout |
| Ledger Schema / Types | Core types + the `Backend` seam + sync→async transform |
| Circuits / Witnesses | Public API surface |
| State Partitioning & Disclosure | Execution-model parity (dry vs live) — the central decision |
| Integration Patterns | Opt-in, backend selection, caller harness |
| Error Handling | Assertion / error-message parity |
| Indexer-visible fields | State-read parity |

## Package & Dependency Layout

Single package, single barrel. Users only ever
`import { … } from '@openzeppelin/compact-simulator'`. No `/live` subpath in user code.

- **Leanness via dynamic import, not subpath export.** Every `@midnight-ntwrk/midnight-js-*`
  import lives *inside* the live module (`src/live/`). `createBackendSimulator` reaches it
  through a runtime `await import('./live/LiveBackend.js')`, fired **only** when
  `MIDNIGHT_BACKEND=live`. A static `import { createBackendSimulator }` never pulls the
  midnight-js stack into the dependency graph.
- **Barrel exports `LiveBackend` as a `type` only**, plus the value-level
  `createBackendSimulator`, `Backend`, `DryBackend`, `LiveContext`, and the `signers`
  helper types. The constructable live *value* is reached solely through the factory's
  dynamic import.
- **Hard constraint:** the barrel must never statically re-export the `LiveBackend`
  *value* (`export { LiveBackend }`). That one line would re-couple the heavy deps to every
  dry import. Type-only re-export keeps the wall up. This must be enforced (lint rule or a
  bundle-size/dep test in CI).
- **Dependency declaration:** the midnight-js packages are `optionalpeerDependencies`.
  Dry-only consumers never install them. `MIDNIGHT_BACKEND=live` without them installed →
  the dynamic import fails with a clear `"install @midnight-ntwrk/… to use live mode"`
  error, not a cryptic module-not-found.

Proposed source layout:

```
packages/simulator/src/
├── core/                      # unchanged: AbstractSimulator, ContractSimulator, CircuitContextManager
├── factory/
│   ├── createSimulator.ts     # unchanged (sync, dry-only)
│   ├── createBackendSimulator.ts   # NEW — async, backend-aware
│   └── SimulatorConfig.ts     # unchanged (reused as-is by both factories)
├── backend/
│   ├── Backend.ts             # NEW — the Backend<P,L> interface
│   └── DryBackend.ts          # NEW — wraps the existing CircuitContext path
├── live/                      # NEW — isolated; only this dir imports midnight-js
│   ├── LiveBackend.ts         # thin adapter over an injected LiveContext
│   ├── LiveContext.ts         # the injection seam (interface + types)
│   └── createLiveContext.ts   # OPTIONAL convenience builder (findDeployedContract + queries)
├── signers/
│   └── Signers.ts             # NEW — alias→key (dry) / alias→wallet (live) resolution
└── index.ts                   # barrel (type-only re-export of LiveBackend)
```

## Core Types & the `Backend` Seam

`SimulatorConfig<P,L,W,TContract,TArgs>` is reused unchanged. Both factories consume the
same `contractFactory`, `defaultPrivateState`, `contractArgs`, `ledgerExtractor`,
`witnessesFactory`. The live path reuses `ledgerExtractor` to turn indexer state into `L`.

**The `Backend` interface** abstracts only the operations that genuinely differ:

```ts
interface Backend<P, L> {
  call(kind: 'pure' | 'impure', name: string, args: unknown[]): Promise<unknown>;
  getPublicState():   Promise<L>;
  getPrivateState():  Promise<P>;
  getContractState(): Promise<StateValue>;
  setCaller(alias: string | null, mode: 'single' | 'persistent'): void;
  readonly contractAddress: string;
}
```

**Sync→async transform.** Today `ContextlessCircuits<Circuits, P>` maps each circuit to
`(...args) => R`. Add an async sibling used by `createBackendSimulator`:

```ts
type AsyncCircuits<Circuits> = {
  [K in keyof Circuits]: (...args: Args<Circuits[K]>) => Promise<Result<Circuits[K]>>;
};
```

`createBackendSimulator` owns the async `pure` / `impure` proxies (the backend stays dumb —
it exposes `call(...)`, the factory builds the proxies on top). **Dry wraps its synchronous
result in `Promise.resolve`; live awaits the network.** Spec code is uniform `await`.

## Public API Surface

**Construction is async** (live must await deploy/handle/query; dry wraps sync):

```ts
// dry  (MIDNIGHT_BACKEND unset|dry)
const sim = await SampleZOwnableSimulator.create(args, options);

// live (MIDNIGHT_BACKEND=live) — caller injects the live world
const sim = await SampleZOwnableSimulator.create(args, { live: liveCtx });
```

**The injection seam — `LiveContext<C,P,L>`, defined by the package, implemented by the
caller's harness** (thin: the caller hands over fully-built per-alias handles + readers):

```ts
interface LiveContext<C, P, L> {
  handleFor(alias: string | null): Promise<DeployedHandle<C>>; // null = default signer; cached per alias
  queryLedger(): Promise<StateValue>;                          // → ledgerExtractor → L
  queryPrivateState(): Promise<P>;
  readonly contractAddress: string;
}
```

`LiveBackend` is then a pure adapter: route `call('impure', name, args)` to
`handleFor(activeAlias).callTx[name](...)` and normalize the result; route
`call('pure', …)` to local JS evaluation (D2); route `getPublicState()` through
`queryLedger()` + `ledgerExtractor`. All midnight-js wiring stays in the caller's harness
or the optional `createLiveContext` helper, never in the package's runtime deps beyond the
type imports inside `src/live/`.

**Per-module authoring is unchanged except async** — swap the factory, add `return`, widen
the return type:

```ts
//  before (dry-only):   transferOwnership(id) { this.circuits.impure.transferOwnership(id); }
//  after (both modes):  transferOwnership(id) { return this.circuits.impure.transferOwnership(id); } // Promise<void>
```

**`Signers` helper** (alias is the common currency for caller identity and circuit args):

```ts
sim.as('OWNER').transferOwnership(newId);     // caller identity
await sim.signers.eitherFor('OWNER');         // Either<ZswapCoinPublicKey, ContractAddress> for circuit args
await sim.signers.keyFor('OWNER');            // raw key
```

Dry resolves an alias to a deterministic key from its label (same trick as the existing
`makeUser('OWNER')` / `generatePubKeyPair('OWNER')`); live resolves it to a pooled,
prefunded wallet.

## Execution-Model Parity (Dry vs Live)

The central design surface. For every operation:

| Operation | Dry (`DryBackend`) | Live (`LiveBackend`) | Seam decision |
|---|---|---|---|
| **Construct** | `create()` runs `initialState` → fresh state per call | attaches to caller-deployed instance via `LiveContext` | args drive deploy in dry; in live the caller deployed already (D3) |
| **Impure call** | run JS circuit, update `CircuitContext` | `handle.callTx[name](...)`, submit tx | normalize live `{public, private:{result}}` → bare `R` |
| **Pure call** | run JS pure circuit, return `R` | **run locally** on the JS artifact, no tx (D2) | identical local path; live keeps the JS contract for this |
| **getPublicState** | `ledgerExtractor(ctx.state)` | `ledgerExtractor(await queryLedger())` | same extractor, async source |
| **getPrivateState** | `ctxManager.currentPrivateState` | `await queryPrivateState()` (provider) | — |
| **as / setPersistentCaller** | alias→deterministic key→`emptyZswapLocalState` | alias→pooled wallet→cached handle | D1 |
| **overrideWitness / set witnesses** | recreate contract with new witnesses | bound at deploy; cannot swap mid-test | **dry-only**; live throws `"witness override unsupported on live backend"` |
| **privateState.* mutation** | `ctxManager.updatePrivateState` | `privateStateProvider.set(id, …)` (best-effort) | asymmetry flagged; witness-injection tests may stay dry-only |
| **Failure** | sync `throw "Foo: msg"` | `callTx` rejects, assert msg propagates as substring | both → `await expect(...).rejects.toThrow(msg)` |

### Decisions

- **D1 — Caller identity unifies on alias *strings*.** Live can sign only with prefunded
  wallets, so `as(OWNER /*CoinPublicKey*/)` becomes `as('OWNER')`. Migrated caller-override
  tests change refs to aliases (a bit more than await-noise, scoped to those tests). Circuit
  args that need a key use `sim.signers.eitherFor('OWNER')` in both modes. **Live cap:** 4
  prefunded wallets (deployer + 3 named aliases) on the dev-preset node; more requires a
  derive-and-fund flow (deferred).
- **D2 — Pure circuits run locally in both modes; only impure circuits hit the node in
  live.** A `pure circuit` is deterministic JS with no ledger/witness, so submitting a tx
  for it would be absurd and would burn one of the 4 wallets. `LiveBackend` keeps the JS
  artifact for local pure eval. Note: some "reads" in these simulators are *impure*
  circuits (e.g. `owner()` in `SampleZOwnableSimulator`) and still go to the node.
- **D3 — Test isolation: deploy-once-shared (default) vs redeploy-per-test (opt-in).** Dry
  gives pristine state every `beforeEach: create()`. Live attaching to one deployed contract
  accumulates state across tests, so the default is deploy-once in `beforeAll` with tests
  tolerating shared state (fast; the CMA branch's approach). Redeploy-per-test gives true
  isolation at minutes-per-suite cost. Consequence: some `beforeEach`-fresh-state
  assumptions in existing tests will not survive live unchanged.

## Integration: Opt-in, Backend Selection, Caller Harness

- **Backend selection** at fixture-construction via `MIDNIGHT_BACKEND`. `package.json`:
  ```json
  "test":      "MIDNIGHT_BACKEND=dry  vitest run",
  "test:live": "MIDNIGHT_BACKEND=live vitest run"
  ```
  Same spec files, flip the env var.
- **Opt-in per module** = swap `createSimulator` → `createBackendSimulator`, add `return`
  to delegating methods, widen return types to `Promise<T>`, and async-migrate that module's
  spec (`await`, `.rejects.toThrow`, alias caller refs). Codemod-assisted (~90% mechanical).
- **Caller harness owns all live infra** — the package ships no docker-compose and no
  endpoint provisioning. The harness (in the consuming repo) builds the
  `EnvironmentConfiguration` from `MIDNIGHT_*` env (localhost defaults, infra assumed
  running), constructs providers, a `WalletPool`, deploys once, and implements `LiveContext`.
  The branch `OpenZeppelin/compact-contracts#489` `_harness/` + fixture is the reference
  shape.
- **Optional `createLiveContext({...})` convenience** (exported from `src/live/`): given
  providers + a `WalletPool` + a `CompiledContract` + `contractAddress`, it builds the
  per-alias `findDeployedContract` handle cache and the `queryLedger` / `queryPrivateState`
  readers — so callers don't re-derive the kit by hand. `LiveBackend` itself stays thin;
  this helper is separate.

## Error & Assertion Parity

- One failure mechanism on both sides surfaces the same way after async migration:
  `await expect(promise).rejects.toThrow(message)`.
- Live wraps the assert message in additional context (proof / tx-failure framing), so
  tests must match on a **substring** (`.toThrow('Foo: msg')`), never assert an exact full
  error string. Confirmed by the branch: `.rejects.toThrow('AccessControl: unauthorized account')`
  passes against the live node.
- Backend responsibility: `LiveBackend` must not swallow or rewrite the contract assert
  message when normalizing the rejection.

## State-Read Parity

- `getPublicState()` / `getContractState()` read the indexer in live
  (`publicDataProvider.queryContractState(address)` → `ledger(state.data)`), the in-memory
  context in dry. Same `ledgerExtractor` over both.
- **Indexer lag:** `callTx` resolves on tx confirmation, but a subsequent indexer read can
  trail by a block. `createLiveContext.queryLedger` should poll/retry briefly to absorb the
  lag before returning, so a `read-after-write` assertion does not flake.
- `getPrivateState()` reads the `levelPrivateStateProvider` (keyed by `privateStateId`) in
  live, the context in dry.

## Change Plan (Extension Mode)

**New:**
- `src/backend/Backend.ts`, `src/backend/DryBackend.ts`
- `src/factory/createBackendSimulator.ts`
- `src/live/{LiveBackend,LiveContext,createLiveContext}.ts`
- `src/signers/Signers.ts`
- `AsyncCircuits<>` type (alongside `ContextlessCircuits`)
- New barrel exports (value: `createBackendSimulator`, `DryBackend`, `Backend`,
  `LiveContext`, `Signers`; type-only: `LiveBackend`)

**Modified:**
- `src/index.ts` — additive exports only; the type-only `LiveBackend` re-export rule.
- `package.json` — add midnight-js packages as `optionalpeerDependencies`; add a CI
  guard that a dry-only import resolves no midnight-js.

**Unchanged (must keep working byte-for-byte for un-migrated modules):**
- `createSimulator`, `AbstractSimulator`, `ContractSimulator`, `CircuitContextManager`,
  `SimulatorConfig`, all existing `types/*`, and every existing synchronous per-module
  simulator + its spec.

**API compatibility / publishing impact:**
- Purely additive to the public API; no breaking change to `createSimulator` consumers.
- Dry-only install footprint is unchanged (heavy deps are optional + dynamically imported).
- No CMA / verifier-key implications for the simulator package itself; those live in the
  contracts under test and the caller's deploy harness.

## Design Decisions Log

- **Single barrel + dynamic import + type-only `LiveBackend` re-export + optional peer
  deps** — the only combination that delivers "no `/live` in user code", "no flag day", and
  "dry path stays lean" simultaneously.
- **`createBackendSimulator` alongside `createSimulator`** (not a replacement) — gradual,
  per-module opt-in; un-migrated modules untouched.
- **Async everywhere on the backend-aware path** — forced by live-infra physics; accepted
  as a one-time, codemod-assisted migration per opted-in module.
- **Thin `LiveBackend` + injected `LiveContext`** — deployment, provider construction, and
  wallet funding are the caller's responsibility (the package ships no infra). Optional
  `createLiveContext` helper reduces caller boilerplate without thickening the backend.
- **D1 alias-string caller identity**, **D2 pure-local-in-both-modes**, **D3
  deploy-once-shared default**.
- **Result normalization** — `LiveBackend` unwraps `callTx`'s `{ public, private:{result} }`
  to the bare `R` that dry returns, so spec assertions are identical across backends.

## Out of Scope

- **Deployment, provider construction, wallet funding, infra provisioning.** The package
  ships no docker-compose and no endpoint setup; the caller's harness owns it. Reason: the
  dev scoped this strictly to the simulator; the deployer is on a branch and not depended
  upon.
- **The `@openzeppelin/compact-deployer` package.** Not a dependency (branch-only as of this
  design).
- **Preprod / testnet targets.** Local node assumed; endpoints come from `MIDNIGHT_*` env.
- **Mid-test witness-implementation swapping on live.** Witnesses bind at deploy; live
  `overrideWitness` is unsupported.
- **More than 4 concurrent live signers** (derive-and-fund flow). Deferred.
- **A first-party fuzzing harness.** Out of scope; `fast-check` remains hand-rolled.

## Dev Notes

- Reference prior art: `OpenZeppelin/compact-contracts#489` (`test/cma-upgradability`)
  `_harness/{network,providers,wallet,walletPool,deploy}.ts` and
  `fixtures/testTokenV1.ts`. Our `createLiveContext` generalizes that fixture's kit.
- The issue names the package `@openzeppelin-compact/contracts-simulator`; the actual name
  is `@openzeppelin/compact-simulator`. Using the real name.

## Open Questions

1. **Result extraction shape** — verify `.private.result` against the installed
   `@midnight-ntwrk/midnight-js-contracts` `callTx` return type, including how
   impure-typed reads (e.g. `owner()`) surface their value. Pin the exact field before
   coding `LiveBackend.call`.
2. **Indexer-lag policy** — concrete retry/poll budget for `queryLedger` (count, backoff,
   ceiling) so live reads are reliable without slowing the suite.
3. **Private-state parity for witness-heavy contracts** — how faithfully can live reproduce
   mid-test private-state injection (e.g. `SampleZOwnable.privateState.injectSecretNonce`)
   via `privateStateProvider.set`? Some such tests may stay dry-only initially; decide the
   policy in invariants/code.
4. **Dry alias→key resolver** — default deterministic derivation vs a caller-supplied
   alias→key map; and how aliases line up with live prefunded seeds so the same alias means
   "the same actor" in both modes.
5. **Codemod** — build a real codemod for the async migration, or hand-migrate the first
   module and template from it?
6. **CI guard** — exact mechanism to assert a dry-only import pulls no midnight-js (bundle
   analysis vs a dependency-graph test).
