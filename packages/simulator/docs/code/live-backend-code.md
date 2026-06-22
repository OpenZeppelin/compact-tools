---
stage: code
project: simulator-live-backend
mode: extension
extends: packages/simulator
status: draft
timestamp: 2026-06-22
author: 0xisk
previous_stage: packages/simulator/docs/design/live-backend-invariants.md
tags: [simulator, testing, live-backend, midnight-js, async, tooling, parity]
---

# Simulator Live-Mode Backend — Code Draft

> Tooling code draft (a TypeScript test harness, not a Compact contract). The
> skill's contract-centric review (disclosure sites, commitment hygiene, `pure`
> discipline) is re-mapped to tooling concerns: the **Parity Mechanisms** table
> replaces Disclosure Sites, and the dependency wall replaces commitment hygiene.

## Revision: unified single-factory API (supersedes the dual-factory design below)

After reviewing the first draft, the dev rejected the dual-factory / duplicate-file
ergonomics. The API was unified per their direction; the engine below is unchanged,
only its surface:

- **One factory.** `createSimulator` IS the async, backend-aware factory (no separate
  `createBackendSimulator`). This is a **breaking change** to the old synchronous
  `createSimulator` — every consumer migrates to `await Sim.create()` + `await`ed
  circuits. The dev accepted this ("change the current unit tests into async/await").
  The old synchronous logic survives as an internal primitive, `createDrySimulator`
  (not exported), which the dry backend wraps and the live backend uses for local
  pure-circuit eval.
- **No twin files.** Per module there is exactly one simulator file and one test file,
  migrated in place to async. `*Backend.ts` twins were removed.
- **Backend selection by env var, two commands.** `MIDNIGHT_BACKEND=dry|live` read once
  at `create()` (INV-8). `test` = dry, `test:live` = live (boots infra + registers the
  harness). Specs guard the documented asymmetries with `isLiveBackend()`
  (e.g. `it.skipIf(isLiveBackend())(...)`).
- **Global live registration.** `registerLiveBackend(factory)` (called once in the
  `test:live` setup) lets `await Sim.create()` stay byte-identical on both backends;
  the live world is resolved from the registry (or an explicit `{ live }`). New file:
  `src/live/registry.ts` (`registerLiveBackend` / `getRegisteredLiveBackend` /
  `clearLiveBackend` / `isLiveBackend`, `LiveBackendFactory` / `LiveBackendRequest`).
- **Private-state mutation + witness read** added to the seam: `setPrivateState` (dry
  mutates, live throws — INV-18), `getWitnesses` + a `witnesses` get/set on the class
  (so `sim.witnesses = {...}` keeps working). Options type renamed
  `BackendSimulatorOptions` → `SimulatorOptions`.

**Validation of the unified API (dry, this revision):**
- Simulator package own suite: **73/73 green** (Simple, Witness, SampleZOwnable, plus
  LiveBackend-adapter / Signers / dependency-wall unit tests), all migrated to async.
- Dependency wall re-verified at build output: `dist/index.js` has **0** real
  `@midnight-ntwrk/midnight-js` imports.
- Real consumer (`compact-contracts`, fresh copy): swapped the built simulator in and
  ran its suite — **1154/1154** previously-passing unit tests unchanged (the 53 reds are
  pre-existing WIP-branch failures, identical with the stock simulator). Migrated the
  `security` module **in place** (Pausable + Initializable, same files, async):
  **19/19 dry green**, matching the pre-migration baseline exactly. `MIDNIGHT_BACKEND=live`
  confirmed to flip the backend and emit the actionable "register a live backend" error
  (no node available here).

The sections below describe the original dual-factory draft and remain accurate for the
engine (Backend seam, Dry/Live backends, Signers, createLiveContext, parity invariants);
read "`createBackendSimulator`" as "`createSimulator`" and "additive / INV-19 sync path
preserved" as "superseded by the unified breaking API" throughout.

## Summary

Adds a backend-aware path alongside the existing synchronous `createSimulator`,
selected by `MIDNIGHT_BACKEND=dry|live` at construction. The new
`createBackendSimulator` builds async circuit proxies over a small `Backend<P,L>`
seam with two implementations: `DryBackend` (a thin async facade over the
unchanged synchronous simulator) and `LiveBackend` (a pure adapter over an
injected `LiveContext`). midnight-js is confined to `src/live/` and reached only
through dynamic imports, so a dry import pulls zero midnight-js — verified at the
build output (`dist/index.js` has no midnight-js references; `createLiveContext.js`
reaches it solely via `await import(...)`). All existing files keep working
byte-for-byte; the change is additive (the full pre-existing dry suite passes as
the INV-19 regression gate).

The two invariants flagged as most likely wrong (INV-13 result shape, INV-17
alias resolution) were **pinned against the installed midnight-js 4.1.0 types**,
not assumptions: the default `callTx[name](...)` returns `FinalizedCallTxData`
whose circuit result is at `.private.result`, and the dry alias derivation
reproduces the existing harness's `toHexPadded(label)`.

## Files

| File | Purpose | Lines | Status |
|------|---------|-------|--------|
| `src/backend/Backend.ts` | The `Backend<P,L>` seam (the operations that differ dry vs live) | ~110 | New |
| `src/backend/DryBackend.ts` | Async facade over the existing synchronous simulator | ~110 | New |
| `src/factory/createBackendSimulator.ts` | Backend-aware factory: env resolve, async proxies, dynamic live import | ~280 | New |
| `src/live/LiveContext.ts` | Structural injection seam (`LiveContext`, `DeployedTxHandle`) | ~75 | New |
| `src/live/LiveBackend.ts` | Pure live adapter (no midnight-js); result/message normalization | ~165 | New |
| `src/live/createLiveContext.ts` | Optional assembler: per-alias handle cache + bounded indexer-lag reads | ~190 | New |
| `src/signers/Signers.ts` | Alias resolver (dry derivation, live cap) | ~190 | New |
| `src/types/Circuit.ts` | Added `AsyncCircuits<>` type (additive) | +20 | Modified |
| `src/types/index.ts` | Re-export `AsyncCircuits` (additive) | +1 | Modified |
| `src/index.ts` | Additive barrel exports (type-only `LiveBackend`) | +30 | Modified |
| `package.json` | Optional peer deps, `test:live` script, dev deps | +20 | Modified |
| `test/integration/SimpleBackend.ts` | Backend-aware simulator (migration template, OQ5) | ~60 | New |
| `test/integration/SimpleBackend.test.ts` | Dry + fake-live parity spec | ~150 | New |
| `test/unit/LiveBackendAdapter.test.ts` | Focused live-adapter unit tests (no node) | ~135 | New |
| `test/unit/Signers.test.ts` | Dry derivation + live cap | ~75 | New |
| `test/unit/dependency-wall.test.ts` | INV-1/INV-2 source guard (OQ6) | ~55 | New |

Verification: `tsc --noEmit` clean, `biome check` clean, `tsc -p .` (build) clean,
**82/82 tests pass** (existing suite + new).

## Invariant Enforcement Map

| Invariant | Enforcement location | Mechanism | Tested |
|-----------|----------------------|-----------|--------|
| INV-1 type-only `LiveBackend` | `src/index.ts`; `createBackendSimulator` dynamic import | `export type { LiveBackend }` + `await import('../live/LiveBackend.js')` | `dependency-wall.test.ts` |
| INV-2 dry graph midnight-js-free | whole graph; `src/live/` confinement | type-only + dynamic imports; verified `dist/index.js` 0 refs | `dependency-wall.test.ts` (source scan) |
| INV-3 optional peer deps | `package.json` | `peerDependenciesMeta.*.optional = true` | — (install-matrix not yet) |
| INV-4 async transform | `AsyncCircuits<>`; `DryBackend.call` | mapped type returns `Promise<R>`; dry wraps in `Promise.resolve` | `SimpleBackend.test.ts` |
| INV-5 shared `SimulatorConfig` | `createBackendSimulator` | consumes the same config; no forked struct | `SimpleBackend.ts` reuses config |
| INV-6 friendly missing-deps error | `createLiveContext.loadFindDeployedContract` | `try/catch` around dynamic import → wrapped message | — (cannot uninstall peers in suite) |
| INV-7 witness override rejected (live) | `LiveBackend.overrideWitness/setWitnesses` | explicit throw `"witness override unsupported on live backend"` | adapter + integration |
| INV-8 backend fixed at construction | `resolveBackendKind` (read once); `backendKind` readonly | no runtime toggle/setter | `SimpleBackend.test.ts` |
| INV-9 isolation (dry fresh / live shared) | convention; migration template comment | documented; specs authored order-independent | — (convention, not code) |
| INV-10 live attaches; dry deploys | `LiveBackend` (no deploy); `LiveContext.contractAddress` | live uses injected address; local sim is in-memory pure-eval only | implicit |
| INV-11 bounded indexer lag | `createLiveContext.queryLedger` | finite retry + capped backoff; throws on exhaustion | — (needs live node; defaults provisional) |
| INV-12 observable-outcome parity | sum of INV-13..18 + lifecycle | dry + fake-live produce same outcomes | `SimpleBackend.test.ts` (both backends) |
| INV-13 result-shape normalization | `LiveBackend.call` (impure) | returns `.private.result` (pinned vs midnight-js 4.1.0) | adapter + integration |
| INV-14 assertion-message parity | `LiveBackend.call` (impure) | awaits directly; never catches/rewrites the rejection | adapter (substring match) |
| INV-15 public-state read parity | `DryBackend`/`LiveBackend.getPublicState` | same `config.ledgerExtractor` over both sources | adapter + integration |
| INV-16 pure-circuit locality | `LiveBackend.call` (pure) → local `pureSim` | pure runs on the JS artifact in both modes | adapter (no handle requested) |
| INV-17 caller-identity parity | `Signers` + `setCaller` lifecycle (both backends) | alias derivation; `single`/`persistent` mirror dry | `Signers.test.ts` + adapter + integration |
| INV-18 private-state read parity | `LiveBackend.getPrivateState` via provider | read parity; mutation documented best-effort/dry-only | adapter (read) |
| INV-19 existing sync path unchanged | all existing `core/*`, `factory/createSimulator`, etc. | additive-only; no runtime logic touched | full existing suite (regression gate) |
| INV-20 public API additive | `src/index.ts` | only new exports; nothing removed/renamed | existing suite + barrel diff |
| INV-21 live signer cap | `Signers` (cap 4) + `assertLiveAliasAllowed` | throws on overflow / out-of-pool; never reuses | `Signers.test.ts` + adapter + integration |
| INV-22 caller owns live infra | `src/live/` boundary; `createLiveContext` inputs | helper only assembles provided pieces; ships no infra | by construction |
| INV-23 parity CI-gated | `package.json` `test:live` script | script present; CI job wiring is a follow-up | — (CI not wired) |

## Parity Mechanisms (tooling analog of Disclosure Sites)

| Surface | Dry | Live | Made-parity-by |
|---------|-----|------|----------------|
| Impure result | proxy returns `R` | `callTx(...).private.result` | INV-13 normalization in `LiveBackend.call` |
| Assert failure | sync `throw "msg"` | `callTx` rejects, message preserved | INV-14: await without catch/rewrite |
| Public state | `ledgerExtractor(ctx state)` | `ledgerExtractor(await queryLedger())` | INV-15: single shared extractor |
| Pure circuit | local JS | local JS (`pureSim`) | INV-16: same local path both modes |
| Caller `as('OWNER')` | deterministic key | pooled wallet (capped) | INV-17 derivation + INV-21 cap |
| Witness override | recreate contract | **hard error** | INV-7 (documented asymmetry) |
| Private-state mutation | context update | best-effort / dry-only | INV-18 (documented asymmetry) |

## Implementation Notes

- **Dependency wall is stronger than the design assumed.** By making `LiveContext`
  a structural injection seam, the live **adapter** (`LiveBackend`) needs no
  midnight-js at all — only the optional **assembler** (`createLiveContext`) does,
  and it reaches it via a single lazy `await import('@midnight-ntwrk/midnight-js-contracts')`.
  Result: every static graph in the package is midnight-js-free; the only runtime
  edge is that one dynamic import, fired only when `createLiveContext()` is called.
- **OQ1 resolved (INV-13).** Verified against installed midnight-js 4.1.0:
  `CircuitCallTxInterface[name](...args): Promise<FinalizedCallTxData>`, and
  `FinalizedCallTxData = CallResult & { private: UnsubmittedTxData } & { public: FinalizedTxData }`,
  so the circuit return value is at `.private.result` and `.public` is tx framing
  (not contract state — hence public state must come from the indexer).
- **OQ4 partially resolved (INV-17).** Dry derivation reproduces the existing
  harness's `toHexPadded(label)` so migrated specs resolve identical keys. Live
  alias→wallet resolution is caller-supplied (`resolveLiveKey`); alignment with
  prefunded seeds remains the harness's job (INV-22).
- **Pure-eval in live.** `createBackendSimulator` always builds the synchronous
  simulator (`localSim`); dry uses it for everything, live uses it only for pure
  circuits. In live this runs `initialState` **in memory only** — never an
  on-chain deploy (INV-10). Pure circuits are state/caller-independent, so the
  seed is irrelevant to results.
- **`super.create` binding.** Per-module subclasses override the static `create`
  and call `super.create(...)` to keep `this` bound to the subclass. Biome's
  `noThisInStatic` would rewrite this to the base-class name and silently break
  it; suppressed with a targeted `biome-ignore` and a comment.

## Deviations from upstream (propose sync — Y/N)

These deviate from the design/invariants prose. None applied to those docs yet:

1. **`./live` subpath dropped; `createLiveContext` exported from the main barrel.**
   Per dev instruction (no sub-directory barrels). Wall is preserved (verified).
   → Propose updating INV-1/INV-20 and the design's Package Layout to drop the
   `./live` subpath. **[Y/N]**
2. **INV-6 friendly error lives in `createLiveContext`, not the `LiveBackend`
   dynamic-import site.** In this architecture `LiveBackend` has no heavy deps, so
   the genuine missing-deps boundary is `createLiveContext`'s dynamic import.
   → Propose noting this enforcement-site refinement in INV-6. **[Y/N]**
3. **`LiveContext<C,P,L>` simplified to `LiveContext<P>`.** `C` and `L` are erased
   into structural types (`DeployedTxHandle`) and the shared `ledgerExtractor`, so
   a harness implements it without midnight-js generics.
   → Propose updating the design's `LiveContext` signature. **[Y/N]**

## Out of Scope

- **INV-23 CI job.** The `test:live` script exists; wiring the dedicated live CI
  job (node infra) is a follow-up, not in this code draft.
- **INV-3 install matrix.** No automated "install without optional peers, run dry
  green" test yet.
- **INV-6 error test.** Not exercised (can't uninstall the peers within the suite).
- **Real-node validation.** INV-11/12/13/14/15/17/18 are covered by dry + a
  deterministic fake `LiveContext`; none are validated against a live node.
- **INV-15 StateValue nesting on live.** `queryLedger` assumes `ContractState.data`
  is the `StateValue` the extractor consumes; needs confirmation against a node.
- **OQ3 private-state mutation on live.** Not implemented; the backend path exposes
  no private-state setter. Mutation/injection tests stay dry-only (existing
  per-module `privateState` helpers).
- **Codemod (OQ5).** Hand-migrated `SimpleBackend` as the template; no codemod.
- **SampleZOwnable migration.** Left dry-only (its `injectSecretNonce` is the
  INV-18 mutation asymmetry); not migrated in this pass.

## Dev Notes

- The fake-`LiveContext` tests (`SimpleBackend.test.ts` live block,
  `LiveBackendAdapter.test.ts`) deterministically exercise the live adapter's
  parity logic — result normalization, assert-message propagation, caller
  lifecycle, signer cap, witness-override rejection — without a node. They are the
  fast floor under INV-12; the live CI job (INV-23) is the real ceiling.
- `package.json` `test` now sets `MIDNIGHT_BACKEND=dry` explicitly (equivalent to
  unset). `test:live` flips it. Same spec files, per the design.

## Open Questions

1. **OQ2 indexer-lag budget** — defaults are `retries: 8, baseDelayMs: 150,
   maxDelayMs: 2000`; tune against a real node.
2. **OQ3 private-state mutation policy on live** — left unimplemented; confirm the
   dry-only policy and whether any provider-`set` path is wanted.
3. **OQ6 CI guard** — implemented as a source-scan test; decide whether to also add
   bundle/dependency-graph analysis.
4. **INV-15 live StateValue** — confirm `ContractState.data` is the right input to
   `ledgerExtractor` against a node.
5. **Live signer wiring** — `resolveLiveKey` + `providersFor` are caller callbacks;
   confirm the harness shape against `OpenZeppelin/compact-contracts#489`.
