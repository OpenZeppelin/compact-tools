---
stage: invariants
project: simulator-live-backend
mode: extension
extends: packages/simulator
status: draft
timestamp: 2026-06-22
author: 0xisk
previous_stage: packages/simulator/docs/design/live-backend.md
tags: [simulator, testing, live-backend, midnight-js, async, tooling, parity]
---

# Simulator Live-Mode Backend — Invariants

> This is a **tooling** invariants pass (a TypeScript test harness), not a Compact
> contract. As the design re-mapped the contract-centric skill sections to tooling
> concerns, the invariant categories are re-mapped too (see table below). The
> distinctive surface here is **dry↔live parity**: it replaces Privacy & Disclosure
> as the central, largest category. The tooling analog of a privacy leak is a
> **false test result** — a green test on one backend that does not mean what a
> green test on the other backend means.

## Summary

The invariants protect three promises the design makes: (1) the **dependency wall** —
a dry import pulls zero midnight-js; (2) **dry↔live parity** — the same spec produces
the same pass/fail outcome on both backends, modulo a small set of explicitly-listed
asymmetries; (3) **additive compatibility** — every un-migrated module and the sync
`createSimulator` path keep working byte-for-byte. The central invariant is INV-12
(observable-outcome parity); most other parity invariants exist to make it true, and
the four asymmetries that cannot be made parity (witness override, test isolation,
private-state mutation, signer cap) are pinned as hard guards or documented exceptions
rather than left implicit. INV-23 keeps parity honest over time by gating it in CI.

Category re-map (mirrors the design's section table):

| Skill category (contracts) | Re-mapped to (tooling) |
|---|---|
| Type-level / circuit-shape | Compile-time / type & dependency-graph (TS, lint, CI guards) |
| Runtime (`assert`) | Runtime guards (throws, dynamic-import errors) |
| State transition | State & test-lifecycle (deploy-once-shared, indexer lag) |
| Privacy & disclosure | **Dry↔Live parity** (central, largest) |
| Authorization & replay | Isolation & compatibility (dep wall, additive API, signer cap) |

"Violation scenario" reframing for this domain: where a contract invariant asks "what
becomes publicly deducible," a parity invariant asks **"what false test result becomes
possible"** — a passing test that verifies nothing, or a failing test that flags
nothing real.

## Compile-Time / Type & Dependency-Graph Invariants

### INV-1: Type-only `LiveBackend` re-export

**Category:** Compile-time / type & dependency-graph

**Statement:** `src/index.ts` exposes `LiveBackend` only via `export type { LiveBackend }`.
The constructable *value* is reachable solely through `createBackendSimulator`'s runtime
`await import('./live/LiveBackend.js')`. The barrel never contains a value re-export
(`export { LiveBackend }`).

**Applies to:** `src/index.ts`.

**Enforcement mechanism:**
- Compiler: `export type` erases at build — no runtime edge from the barrel to `src/live/`.
- Test: lint rule forbidding a value re-export of `LiveBackend` from the barrel; the
  INV-2 dep-graph guard catches any regression that reintroduces the edge.

**Violation scenario:** One stray `export { LiveBackend }` statically links `src/live/` —
and therefore the entire midnight-js stack — into every dry import. Leanness is silently
lost; no test fails unless the INV-2 guard exists.

**Severity:** Critical

---

### INV-2: Dry import graph free of midnight-js

**Category:** Compile-time / type & dependency-graph

**Statement:** Any import reachable without `MIDNIGHT_BACKEND=live` (the barrel,
`createBackendSimulator`, `Backend`, `DryBackend`, `Signers`, `createSimulator`) resolves
zero `@midnight-ntwrk/midnight-js-*` modules. midnight-js loads only via the runtime
dynamic import inside `createBackendSimulator` when `MIDNIGHT_BACKEND=live`. All
midnight-js imports are physically confined to `src/live/`.

**Applies to:** whole-package dependency graph; `src/live/*` is the sole midnight-js importer.

**Enforcement mechanism:**
- Test: CI guard — a dependency-graph test or bundle analysis asserting a dry entry point
  resolves no midnight-js module (exact mechanism is Open Question 6).

**Violation scenario:** Dry-only consumers pay the install, bundle, and cold-start cost of
a heavy stack they never use. The core value proposition of the design breaks silently —
nothing surfaces until a consumer notices the bloat.

**Severity:** Critical

---

### INV-3: midnight-js declared as optional peer dependencies

**Category:** Compile-time / type & dependency-graph

**Statement:** Every `@midnight-ntwrk/midnight-js-*` dependency is an optional peer
dependency (`peerDependencies` + `peerDependenciesMeta.*.optional = true`). Dry-only
consumers install and run the package without them present.

**Applies to:** `package.json`.

**Enforcement mechanism:**
- Test: CI install matrix — install without the optional peers, run the dry suite green.

**Violation scenario:** Dry consumers are forced to install the heavy stack (or install
fails), defeating leanness at the install boundary even if the runtime graph (INV-2) is clean.

**Severity:** High

---

### INV-4: Async circuit signature transform

**Category:** Compile-time / type & dependency-graph

**Statement:** `createBackendSimulator` exposes every circuit `K` as
`(...args: Args<K>) => Promise<Result<K>>` (the `AsyncCircuits<>` mapped type). `DryBackend`
wraps its synchronous result in `Promise.resolve`; live awaits the network. Spec code is
uniform `await` across both backends.

**Applies to:** `AsyncCircuits<>`, `createBackendSimulator` proxies, `DryBackend.call`.

**Enforcement mechanism:**
- Compiler: the `AsyncCircuits<>` mapped type forces `Promise`-returning signatures.
- Runtime check: `DryBackend.call` returns `Promise.resolve(syncResult)` so a circuit never
  returns a bare value on one backend and a `Promise` on the other.

**Violation scenario:** A circuit returning a bare value on dry but a `Promise` on live makes
`await` behave differently per backend — parity broken at the type level before any test runs.

**Severity:** High

---

### INV-5: Shared `SimulatorConfig` across both factories

**Category:** Compile-time / type & dependency-graph

**Statement:** `createSimulator` and `createBackendSimulator` consume the identical
`SimulatorConfig<P,L,W,TContract,TArgs>` (same `contractFactory`, `defaultPrivateState`,
`contractArgs`, `ledgerExtractor`, `witnessesFactory`). The live path reuses `ledgerExtractor`
to turn indexer state into `L`.

**Applies to:** `src/factory/SimulatorConfig.ts` (unchanged), both factories.

**Enforcement mechanism:**
- Compiler: single shared type; no forked config struct.

**Violation scenario:** Config drift between factories means a module's config describes a
different contract in dry vs live — a maintenance and parity hazard that compounds per module.

**Severity:** Medium

## Runtime Guard Invariants

### INV-6: Clear missing-deps error in live mode

**Category:** Runtime guard

**Statement:** `MIDNIGHT_BACKEND=live` with midnight-js not installed → the dynamic import
fails with a message naming the missing package and the fix (`"install @midnight-ntwrk/… to
use live mode"`), not a raw `ERR_MODULE_NOT_FOUND`.

**Applies to:** `createBackendSimulator` dynamic-import site.

**Enforcement mechanism:**
- Runtime check: `try/catch` around `await import('./live/LiveBackend.js')`, rethrowing a wrapped error.
- Test: stub a resolution failure; assert the friendly message.

**Violation scenario:** A cryptic module-not-found leads devs to think the package is broken
rather than that they opted into live without the optional peers. DX only, not a safety break.

**Severity:** Medium

---

### INV-7: Witness override rejected on live

**Category:** Runtime guard

**Statement:** On the live backend, `overrideWitness(...)` and the `witnesses` setter throw
`"witness override unsupported on live backend"`. Witnesses bind at deploy and cannot be
swapped mid-test. Dry continues to support both.

**Applies to:** `overrideWitness`, `set witnesses` (live backend path).

**Enforcement mechanism:**
- Runtime check: explicit throw in the live path before any state mutation.
- Test: call `overrideWitness` on a live sim → rejects with the exact message substring.

**Violation scenario:** A silent no-op lets a witness-injection test that *intends* to swap a
witness run against the unchanged deployed witness — a false green on a privacy/auth-critical
path. A developer reads "witness-rejection test passes" and ships a contract whose witness check
was never actually exercised. The throw is the entire mitigation, so the consequence is Critical;
the design's dry-only routing reduces likelihood, not impact.

**Severity:** Critical

---

### INV-8: Backend selection is construction-time and fixed

**Category:** Runtime guard

**Statement:** `MIDNIGHT_BACKEND` is read once at fixture/simulator construction. A constructed
simulator does not change backends over its lifetime; there is no runtime backend toggle.

**Applies to:** `createBackendSimulator` / `Module.create`.

**Enforcement mechanism:**
- Runtime check: the backend is resolved at `create()`; no setter is exposed.

**Violation scenario:** A mid-life backend switch would split state across two worlds (in-memory
vs on-chain), producing an incoherent test whose result means nothing.

**Severity:** Medium

## State & Test-Lifecycle Invariants

### INV-9: Test-isolation model (dry fresh vs live shared)

**Category:** State & test-lifecycle

**Statement:** Dry yields pristine state per `create()` (`beforeEach`). Live's default is
deploy-once-shared (`beforeAll`), with state accumulating across tests; redeploy-per-test is
opt-in at minutes-per-suite cost (D3). A spec meant to run on both must not assume
`beforeEach`-fresh state unless it uses redeploy-per-test.

**Applies to:** `create()`, suite lifecycle, D3.

**Enforcement mechanism:**
- Convention + the opt-in redeploy switch; the isolation mode is documented per migrated module.
- Test: migrated specs are authored order-independent (or marked redeploy-per-test).

**Violation scenario:** A spec relying on fresh-per-test state passes on dry but sees accumulated
state on live (order-dependent flake or false result). This is the defining lifecycle parity hazard
and the one most likely to bite a mechanical migration.

**Severity:** High

---

### INV-10: Live attaches; dry deploys

**Category:** State & test-lifecycle

**Statement:** In dry, `create(args)` deploys from `contractArgs` → fresh state. In live, the
caller deploys (via `LiveContext`); `create()` attaches to that instance and never deploys from args.

**Applies to:** `create()`, `DryBackend` vs `LiveBackend` construction (D3).

**Enforcement mechanism:**
- Runtime: `DryBackend` runs `initialState`; `LiveBackend.contractAddress` comes from `LiveContext`;
  `LiveBackend` performs no deploy.

**Violation scenario:** A double-deploy or arg-driven deploy on live diverges the address/state from
what the harness set up — subsequent reads target the wrong instance.

**Severity:** Medium

---

### INV-11: Bounded indexer-lag absorption

**Category:** State & test-lifecycle

**Statement:** The live public-state read path (`queryLedger`) polls/retries within a **bounded**
budget (finite count + backoff + ceiling) to absorb indexer block-lag after a `callTx` resolves, so
a read-after-write assertion is stable. The budget is never an unbounded wait.

**Applies to:** `createLiveContext.queryLedger`, `LiveBackend.getPublicState`.

**Enforcement mechanism:**
- Runtime: retry loop with explicit count/backoff/ceiling (concrete numbers are Open Question 2).

**Violation scenario:** Too short → read-after-write flakes (false failure). Unbounded → a genuinely
missing write hangs the suite instead of failing it. Both destroy the test's meaning in opposite directions.

**Severity:** High

## Dry↔Live Parity Invariants

> The central category — the tooling analog of Privacy & Disclosure. INV-12 is the umbrella
> promise; INV-13..INV-18 are the mechanisms that make it true or the documented asymmetries
> that bound it.

### INV-12: Observable-outcome parity (umbrella)

**Category:** Dry↔Live parity

**Statement:** For any spec authored against `createBackendSimulator`, each assertion's pass/fail
outcome is the same under `MIDNIGHT_BACKEND=dry` and `=live`, **modulo the four explicitly-listed
asymmetries**: (1) witness override (INV-7, hard-errors on live); (2) test isolation and
constructor-arg effect (INV-9 + INV-10, live shares one deploy); (3) private-state mutation (INV-18,
best-effort on live); (4) signer cap (INV-21, live caps at 4 aliases while dry is unlimited). Outside
those four, a green dry test means the same thing as a green live test. **This list is closed** — any
divergence not on it is a bug, not a new asymmetry to document after the fact.

**Applies to:** every public operation; the design's central promise.

**Enforcement mechanism:**
- The sum of INV-13..INV-18 plus the lifecycle invariants makes outcomes identical.
- Gated by INV-23: the same spec runs on both backends in CI; divergence outside the four asymmetries is a failure.

**Violation scenario:** Divergence makes a passing test meaningless — the tooling analog of a privacy
leak. A dev trusts a dry-green suite and ships a contract that behaves differently against a real node
(or abandons a correct change because live falsely reds).

**Severity:** Critical

---

### INV-13: Result-shape parity (normalization to bare `R`)

**Category:** Dry↔Live parity

**Statement:** `LiveBackend.call('impure', name, args)` normalizes `callTx`'s
`{ public, private: { result } }` to the bare `R` that `DryBackend` returns. Impure reads (e.g.
`owner()`) surface the same `R` shape in both modes. After normalization, an assertion on the return
value is identical across backends.

**Applies to:** `LiveBackend.call` (impure path), impure reads.

**Enforcement mechanism:**
- Runtime: normalization in `LiveBackend.call`, pinned against the installed
  `@midnight-ntwrk/midnight-js-contracts` `callTx` return type (Open Question 1 — must be verified
  before this is final).
- Test: a parity assertion comparing the dry and live return values for the same call.

**Violation scenario:** A spec must branch on backend to read a result (parity broken), or an
assertion silently reads the wrong nested field and produces a false pass/fail.

**Severity:** Critical

---

### INV-14: Assertion-message parity

**Category:** Dry↔Live parity

**Statement:** A contract `assert` failure surfaces on both backends so that
`await expect(p).rejects.toThrow('Foo: msg')` matches by **substring**. `LiveBackend` must not swallow
or rewrite the contract assert message when normalizing the rejection; live may add surrounding
proof/tx framing, so specs match on a substring, never an exact full string.

**Applies to:** failure path of every impure call; `LiveBackend` rejection normalization.

**Enforcement mechanism:**
- Runtime: `LiveBackend` preserves the underlying message in the thrown/rejected error.
- Convention + test: specs use substring matching; a negative test runs green on both backends.

**Violation scenario:** A swallowed/rewritten message makes an expect-revert test pass on dry but not
match on live (false failure); a match-anything fallback makes any rejection satisfy the assertion (false pass).

**Severity:** Critical

---

### INV-15: Public-state read parity

**Category:** Dry↔Live parity

**Statement:** `getPublicState()` / `getContractState()` apply the same `ledgerExtractor` in both modes —
over the in-memory `CircuitContext` (dry) and over the indexer-sourced `StateValue` (live). The extracted
`L` is structurally identical for equivalent state.

**Applies to:** `getPublicState`, `getContractState`; the shared `ledgerExtractor`.

**Enforcement mechanism:**
- Runtime: the single `ledgerExtractor` from `SimulatorConfig` (INV-5) is the only extraction path for both backends.

**Violation scenario:** Divergent extraction makes state assertions mean different things per backend, even
when the underlying contract state is the same.

**Severity:** High

---

### INV-16: Pure-circuit locality parity

**Category:** Dry↔Live parity

**Statement:** Pure circuits run locally on the JS artifact in **both** modes (no tx in live); only impure
circuits hit the node in live. `LiveBackend` retains the JS contract for local pure evaluation. Locality
follows pure/impure, **not** read/write: reads implemented as impure circuits (e.g. `owner()`) still go to
the node in live (D2).

**Applies to:** `LiveBackend.call` routing (`'pure'` → local JS, `'impure'` → `handle.callTx`).

**Enforcement mechanism:**
- Runtime: `call('pure', …)` evaluates locally; `call('impure', …)` submits a tx.

**Violation scenario:** Submitting a tx for a pure circuit burns one of the 4 wallets and can diverge results;
treating an impure read as local skips the node and reads stale local state → false parity.

**Severity:** High

---

### INV-17: Caller-identity parity

**Category:** Dry↔Live parity

**Statement:** `as('OWNER')` denotes the same logical actor in both modes, and
`signers.eitherFor('OWNER')` / `keyFor('OWNER')` resolve to a value consistent with that actor. Dry derives
a deterministic key from the alias label; live resolves the alias to a fixed prefunded wallet — and the
alias→actor mapping is aligned so "OWNER" is the same party across backends (D1). The
`setCaller(alias, mode)` **mode semantics also match across backends**: `'single'` applies the caller to the
next call then reverts to the default signer; `'persistent'` keeps it until changed. The revert-after-one-call
lifecycle of `'single'` behaves identically on dry and live.

**Applies to:** `as`, `setPersistentCaller`, `Backend.setCaller(alias, mode)`, `signers.eitherFor`, `signers.keyFor`.

**Enforcement mechanism:**
- Runtime: the `Signers` resolver; the dry derivation and live seed assignment share one alias→actor mapping
  (Open Question 4 pins the resolver and the alignment).
- Runtime: both backends implement the same `'single'`/`'persistent'` lifecycle in `setCaller`.
- Test: a `'single'`-mode call followed by a default-signer call asserts the same active caller on both backends.

**Violation scenario:** If `'OWNER'` maps to different keys/actors across backends, an authorization test
passes on one backend and fails on the other — a false result that looks like a flaky auth check.

**Severity:** High

---

### INV-18: Private-state read parity (with documented mutation asymmetry)

**Category:** Dry↔Live parity

**Statement:** `getPrivateState()` returns the contract's private state `P` in both modes — from the
`CircuitContext` (dry) and from `levelPrivateStateProvider` keyed by `privateStateId` (live). **Read parity
holds.** **Mutation/injection parity does NOT:** live `privateState.*` mutation is best-effort via
`privateStateProvider.set`, and mid-test secret/witness injection (e.g.
`SampleZOwnable.privateState.injectSecretNonce`) may not faithfully reproduce on live, so such tests may
remain dry-only (Open Question 3).

**Applies to:** `getPrivateState` (read parity), `privateState.*` mutation (asymmetry).

**Enforcement mechanism:**
- Runtime: `LiveBackend.getPrivateState` via the provider; mutation documented as best-effort / dry-only.
- Test: read parity asserted on both backends; injection tests tagged dry-only until the policy is decided.

**Violation scenario:** Assuming mutation parity makes a private-state-injection test green on dry while the
injection never takes effect on live — false confidence in a privacy-critical path. Read divergence yields
wrong private-state assertions.

**Severity:** High

## Isolation & Compatibility Invariants

### INV-19: Existing sync path unchanged byte-for-byte

**Category:** Isolation & compatibility

**Statement:** `createSimulator`, `AbstractSimulator`, `ContractSimulator`, `CircuitContextManager`,
`SimulatorConfig`, all existing `types/*`, and every existing synchronous per-module simulator + spec keep
working unchanged. The new work is strictly additive; no existing file's runtime behavior changes.

**Applies to:** all existing `src/core/*`, `src/factory/createSimulator.ts`, `src/factory/SimulatorConfig.ts`,
`src/types/*`, `src/proxies/*`, and every un-migrated module.

**Enforcement mechanism:**
- Test: the full existing dry suite passes unchanged as a regression gate; additive-only diff to existing files.

**Violation scenario:** A regression in the sync path breaks every un-migrated module at once — the per-module
opt-in promise (no flag day) fails.

**Severity:** Critical

---

### INV-20: Public API purely additive

**Category:** Isolation & compatibility

**Statement:** The barrel only gains exports — values `createBackendSimulator`, `DryBackend`, `Backend`,
`LiveContext`, `Signers`; type-only `LiveBackend` (INV-1). No existing export is removed, renamed, or changed
in signature. `createSimulator` consumers see no breaking change.

**Applies to:** `src/index.ts`.

**Enforcement mechanism:**
- Test: additive barrel diff; optionally an API-extractor / export-snapshot test.

**Violation scenario:** A breaking barrel change forces every consumer to migrate, violating the no-flag-day goal.

**Severity:** High

---

### INV-21: Live signer cap enforced, not silently exceeded

**Category:** Isolation & compatibility

**Statement:** Live supports exactly the prefunded set — deployer + 3 named aliases = 4 on the dev-preset node
(D1). Requesting an alias beyond the funded pool fails with a clear error pointing at the deferred
derive-and-fund flow. It never silently reuses a wallet or proceeds with an unfunded one.

**Applies to:** `Signers` / `WalletPool` live resolution.

**Enforcement mechanism:**
- Runtime: a bounds-check in the live alias resolver that throws on overflow.
- Test: requesting a 5th distinct alias on live → rejects with the cap message.

**Violation scenario:** Silent wallet reuse collapses two aliases into one actor → authorization tests pass
spuriously. An unfunded wallet → opaque tx failure that looks like a contract bug.

**Severity:** Medium

---

### INV-22: Caller harness owns all live infra

**Category:** Isolation & compatibility

**Statement:** The package ships no docker-compose, no endpoint provisioning, no deploy. All live infra
(`EnvironmentConfiguration` from `MIDNIGHT_*` env, providers, `WalletPool`, deploy, `LiveContext` impl) lives
in the consuming harness. The optional `createLiveContext` helper only assembles already-provided pieces
(providers + `WalletPool` + `CompiledContract` + `contractAddress`).

**Applies to:** `src/live/*` boundary; `createLiveContext`.

**Enforcement mechanism:**
- Boundary by construction: `src/live/` contains only the adapter + optional assembler, no infra; reviewed at code stage.

**Violation scenario:** Leaking infra into the package re-introduces heavy deps / environment assumptions into the
dependency graph (threatening INV-2) and couples the simulator to one topology.

**Severity:** Medium

---

### INV-23: Parity is CI-gated per migrated module

**Category:** Isolation & compatibility

**Statement:** A module counts as *migrated* only if its single spec runs green on **both** backends in CI —
`MIDNIGHT_BACKEND=dry vitest run` and `MIDNIGHT_BACKEND=live vitest run`. Live is run in a dedicated CI job
with the node infra available. A migrated module that is green on dry but not exercised (or not green) on live
is not actually migrated, and the gate must block the merge. Un-migrated modules run dry-only and are exempt.

**Applies to:** CI configuration; the migrated-module set.

**Enforcement mechanism:**
- Test/CI: a `test:live` job over the migrated set; a migrated module missing from it (or red on it) fails the gate.
- This is what operationalizes INV-12 — parity is verified continuously, not asserted once at migration time.

**Violation scenario:** Without the gate, a module migrated months ago silently drifts: a later dry-only change
breaks live parity and no one notices until a real-node run surprises someone. Parity rot is the failure mode
this invariant exists to prevent.

**Severity:** High

## Existing Invariants (Extension Mode)

### Preserved (must not break — formalized by INV-19, INV-20)

- `createSimulator` stays **synchronous**: returns a class extending `ContractSimulator<P,L>`; constructor is sync
  (`src/factory/createSimulator.ts:42`).
- `getPublicState(): L` is **synchronous** in the existing path via `config.ledgerExtractor(...)`
  (`createSimulator.ts:144`).
- Circuit proxies are `ContextlessCircuits<C, P>` = `(...args) => R` (sync) in the existing path
  (`src/proxies/CircuitProxies.ts`, `src/types/Circuit.ts`).
- `overrideWitness` / `set witnesses` recreate the contract and reset proxies — dry behavior preserved
  (`createSimulator.ts:165-182`). Live diverges deliberately (INV-7).
- Constructor defaults preserved: `coinPK = '0'.repeat(64)`, `contractAddress = dummyContractAddress()`
  (`createSimulator.ts:48-53`).
- Barrel exports both values and types as today (`src/index.ts`); new exports are additive (INV-20), with the
  type-only `LiveBackend` rule (INV-1).

### Modified

- **None.** The "simulator class is the single test-facing API" goal is delivered by a *new* additive factory
  (`createBackendSimulator`), not by modifying the existing class or its proxies. No existing invariant changes.

### New

- INV-1 through INV-22 are all new, introduced by the backend-aware path.

## Invariant Coverage Matrix

| Operation / surface | Invariants | Enforcement |
|---|---|---|
| `createBackendSimulator` / `Module.create` | INV-4, INV-5, INV-8, INV-9, INV-10, INV-19, INV-20 | TS types + construction-time backend resolve + additive diff |
| Impure call | INV-4, INV-12, INV-13, INV-14, INV-16 | Async proxy + result/message normalization + pure/impure routing |
| Pure call | INV-4, INV-12, INV-16 | Local JS eval in both modes |
| `getPublicState` / `getContractState` | INV-11, INV-12, INV-15 | Shared `ledgerExtractor` + bounded indexer-lag retry |
| `getPrivateState` | INV-12, INV-18 | Provider read (live) / context (dry); mutation asymmetry documented |
| `as` / `setPersistentCaller` | INV-12, INV-17, INV-21 | `Signers` resolver + signer-cap bounds-check |
| `signers.eitherFor` / `keyFor` | INV-17, INV-21 | Alias→actor mapping aligned across backends |
| `overrideWitness` / `set witnesses` | INV-7, INV-19 | Live throws; dry preserved |
| `privateState.*` mutation | INV-18 | Best-effort provider set; injection tests may stay dry-only |
| Barrel / dry import | INV-1, INV-2, INV-3, INV-20 | Type-only re-export + dep-graph CI guard + optional peers |
| Live module load | INV-2, INV-6 | Dynamic import + wrapped missing-deps error |
| Failure path (`rejects.toThrow`) | INV-14 | Message preserved as substring |
| CI parity gate (migrated module) | INV-12, INV-23 | `test:dry` + `test:live` both green to count as migrated |
| Existing sync simulators + specs | INV-19 | Full existing dry suite as regression gate |

## Out of Scope

- **Performance / timing parity.** Live is slower by physics; no invariant claims equal wall-clock or per-op latency.
- **Gas / fee accounting parity.** Not modeled by the simulator on either backend.
- **Private-state mutation/injection parity on live.** Best-effort only (INV-18); faithful mid-test injection is not
  guaranteed, and such tests may stay dry-only. Reason: provider semantics differ from in-memory context; policy is Open Question 3.
- **Mid-test witness-implementation swapping on live.** Hard-errors (INV-7); witnesses bind at deploy. Reason: no on-chain mechanism to rebind.
- **More than 4 concurrent live signers.** Fails clearly (INV-21); derive-and-fund flow deferred. Reason: dev-preset node prefunds 4 wallets.
- **Deployment, provider construction, wallet funding, infra provisioning.** Caller-harness responsibility (INV-22); the package ships none. Reason: dev scoped strictly to the simulator.
- **`@openzeppelin/compact-deployer` integration.** Branch-only as of this design; not a dependency.
- **Preprod / testnet parity.** Local node assumed; endpoints from `MIDNIGHT_*` env.
- **First-party fuzzing.** `fast-check` stays hand-rolled.

## Dev Notes

- **Parity is the load-bearing property.** Read every parity invariant (INV-12..INV-18) as either "this is made
  identical across backends" or "this is a documented asymmetry with a hard guard." There is no third state — an
  undocumented divergence is the bug class this whole document exists to prevent.
- INV-13 (result shape) and INV-17 (alias resolution) are the two parity invariants most likely to be wrong in the
  first code draft, because both depend on midnight-js details not yet pinned (Open Questions 1 and 4). Treat their
  enforcement as provisional until verified against the installed packages.
- Reference prior art for the live harness shape: `OpenZeppelin/compact-contracts#489`
  (`test/cma-upgradability/_harness/*`, `fixtures/testTokenV1.ts`). `createLiveContext` generalizes that fixture's kit.

## Open Questions

1. **Result-extraction shape (blocks INV-13).** Verify `.private.result` against the installed
   `@midnight-ntwrk/midnight-js-contracts` `callTx` return type, including how impure-typed reads (e.g. `owner()`)
   surface their value. INV-13's normalization is provisional until pinned.
2. **Indexer-lag budget (concretizes INV-11).** Decide the retry count, backoff, and ceiling for `queryLedger` so
   read-after-write is stable without slowing the suite.
3. **Private-state mutation parity (bounds INV-18).** How faithfully can live reproduce mid-test private-state
   injection via `privateStateProvider.set`? Decide which tests stay dry-only and codify the policy in code/tests.
4. **Dry alias→key resolver + live alignment (concretizes INV-17).** Deterministic derivation vs caller-supplied
   alias→key map, and how aliases line up with live prefunded seeds so "the same alias = the same actor" in both modes.
5. **Codemod vs hand-migrate (process, not an invariant).** Build a real codemod for the async migration, or hand-migrate
   the first module and template from it?
6. **CI guard mechanism (concretizes INV-1/INV-2 enforcement).** Dependency-graph test vs bundle analysis to assert a
   dry-only import pulls no midnight-js.
