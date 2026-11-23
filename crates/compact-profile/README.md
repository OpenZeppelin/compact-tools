# compact-profile

Capacity profiler for Midnight Compact contract transactions. A runner builds one
unproven ledger transaction per scenario and lists them in a manifest. This tool
re-costs each transaction with the Rust ledger, checks the numbers against the
runner's, evaluates every per-transaction limit of a network, counts how many
transactions fit in a block, and fails when the results drift from a committed
snapshot. Output is deterministic: no timestamps, no timings, fixed ordering.

## Install

```sh
cargo install --path crates/compact-profile
```

## Usage

```sh
compact-profile params --network <name> [--out <file>] [--reporter table|json]
compact-profile cost <tx> --network <name> [--reporter table|json]
compact-profile check --manifest <file> --network <name>... --snapshot <file> [--reporter table|json] [--size-tolerance <bytes>]
compact-profile update --manifest <file> --network <name>... --snapshot <file> [--reporter table|json]
```

- `--network <name>`: a shipped profile, `mainnet`, `preprod` or `undeployed`.
  `check` and `update` take it more than once.
- `--profile-file <file>`: a profile on disk. It replaces the shipped profile of
  the same name, or adds a network. Two files with one profile name are an error.
- `params` prints the params identity; `--reporter json` prints `network`,
  `provisional`, `nodeRelease`, `ledgerCrate`, `paramsIdentity` and
  `minClientLedger` (string or `null`). With `--out` it also writes the tagged
  `LedgerParameters` bytes, which the runner hands to the JS ledger.
- `cost` evaluates one transaction in any form: unproven, proven, or proven and
  balanced by a wallet, told apart by the tag header. It exits 0 whenever it
  computed a result; read `fits`.
- `check` and `update` read unproven transactions only, and exit 2 on any other form.
- `check` exits 1 on a parity mismatch or on any drift from the snapshot.
- `update` writes the snapshot. It writes nothing and exits 1 on a parity mismatch.
- Exit 2 is an error: bad input, a params identity that differs from the
  profile's, a missing snapshot, a transaction the ledger cannot read.
- Results go to stdout; warnings, the one-line summary and errors go to stderr.
- `check` and `update` compare the manifest's `toolchain["@midnightntwrk/ledger-v9"]`
  with each network's minimum client ledger (semver order, so `1.0.0-rc.5` is below
  `1.0.0`). Below the minimum, stderr warns and the report labels that network
  `client below minimum`; it is not a failure. An absent or unparsable version is
  reported once on stderr and labels nothing.

## Network profile

TOML, embedded from `profiles/`.

| Key | Meaning |
|---|---|
| `name`, `provisional` | Network name; `provisional` while facts are unmeasured |
| `node_release`, `ledger_crate`, `captured`, `source` | Provenance |
| `parameters` | Tagged `LedgerParameters`, hex; whitespace ignored |
| `[node.<cap>]` | `value` (optional) and `source` (required) |
| `[balancing]` | `source`, and `nodes`, `bytes`, `further_intent_bytes`, `cost` together or not at all: what a wallet's fee payment adds to a one-intent transaction, and the bytes each further intent adds |
| `[proof]` | Optional; `source`, and `call_bytes`, `builtin_bytes` together or not at all: bytes proving adds per contract call proof and per built-in proof beyond the ledger's estimate |
| `[min_client_ledger]` | Optional; `value` (semver, optional) and `source`: the oldest npm `@midnightntwrk/ledger-v9` known to build transactions the network accepts |

Node caps: `max_transaction_nodes`, `weight_scale`, `fixed_extra_weight`,
`base_extrinsic_weight`, `extrinsic_weight_ceiling`, `normal_block_weight`,
`normal_block_length`.

A built-in proof is a Zswap input or output proof or a Dust spend proof; a Zswap
transient holds two.

The `mainnet` and `preprod` caps, balancing term and proof term were observed on
2026-11-20 on a local dev chain running node 2.1.101, spec_version 2001100, the
runtime both networks reported that day. On 2026-11-23 each network's own runtime metadata
showed the same caps, and its storage left `fixed_extra_weight` unset, so the
runtime default applies. `undeployed` is the dev chain, so it carries the same
caps. A local stack on another node release needs its own profile file.

## Manifest

JSON, written by the runner. `schemaVersion` is `1`.

| Field | Meaning |
|---|---|
| `contract` | Free-form name |
| `toolchain` | Free-form `{ tool: version }` |
| `paramsIdentity` | What `compact-profile params` printed |
| `scenarios[].name` | Unique |
| `scenarios[].series`, `.n` | Optional, together; one series per name, one entry per `n` |
| `scenarios[].calls` | Contract calls in the transaction |
| `scenarios[].ops` | Optional, at least 1, default `calls`: logical operations the transaction performs, such as mints in a batch circuit |
| `scenarios[].conflict` | `none`, or `serial` when two copies cannot share a block |
| `scenarios[].tx` | Serialized unproven transaction, relative to the manifest |
| `scenarios[].js` | `cost` (five decimal strings), `serializedLen`, `declaredNodes` |

Cost fields are `readTime`, `computeTime` (picoseconds), `blockUsage`,
`bytesWritten`, `bytesChurned`. The runner reports `tx.cost(params, false)`.

## `cost --reporter json`

One object. Numbers that can pass `2^53` are decimal strings.

| Field | Meaning |
|---|---|
| `network`, `provisional`, `nodeRelease`, `ledgerCrate` | The profile |
| `scope` | `contract-only`, `balanced` or `as-submitted` |
| `paramsIdentity` | The profile's params identity |
| `form` | `unproven`, `proven` or `balanced` |
| `serializedLen`, `estimatedSize`, `declaredNodes` | The transaction as read, as numbers |
| `cost` | Five decimal strings, as in the manifest |
| `proofTerm` | `status`, `callProofs`, `builtinProofs` and `bytes` |
| `balancingTerm` | `intents` and `bytes` |
| `timeToDismiss` | `used` and `allowed`, decimal strings |
| `weight` | What the transaction adds to the block total, base included; decimal string, or `null` while a part is unknown |
| `limits[]` | `name`, `used`, `allowed`, `ratioPpm`, `status` |
| `fits` | `true` when no limit is `over` |
| `binding` | The limit with the highest ratio, or `null` |

- `serializedLen`, `estimatedSize`, `declaredNodes` and `cost` are the transaction
  as read. `timeToDismiss`, `weight` and `limits` include the balancing term when
  `scope` is `balanced`, and the proof term when `proofTerm.status` is `added`.
- `proofTerm.status` is `added` for an unproven transaction under a profile that
  knows the term, `proven` for a proven or balanced one, which holds its proofs,
  and `unknown` otherwise. `callProofs` and `builtinProofs` count the
  transaction's proofs. `bytes` is the decimal string added, or `null` unless
  `added`.
- `balancingTerm.intents` counts the transaction's intents. `bytes` is the decimal
  string the balancing term added to the size, or `null` unless `scope` is
  `balanced`.
- `limits[].name`, in order: `nodes`, `txBytes`, `readTime`, `computeTime`,
  `blockUsage`, `bytesWritten`, `bytesChurned`, `timeToDismiss`,
  `extrinsicWeight`, `blockWeight`, `blockLength`.
- `used` and `allowed` are decimal strings, or `null` when unknown. Limits read the
  transaction with the balancing term added, except for a balanced one.
- `extrinsicWeight` uses the dispatch weight, without the base;
  `blockWeight` uses `weight`, with it.
- `ratioPpm` is `used / allowed` in parts per million, rounded up, so it passes
  1,000,000 exactly when `used > allowed`. `null` when either side is unknown.
- `status` is `ok`, `over` or `n/a`.

`check --reporter json` nests the same fields per scenario under
`networks[].scenarios[]`, with `calls`, `ops` and a `block` object (`bounds`,
`txsPerBlock`, `binding`, `opsPerBlock`). Each network adds `minClientLedger` and
`clientBelowMinimum`. The top level adds `parity`, the series `lines`, each
network's `series` and, for `check`, `drift`.

## Table

Per network: a header line (name, node release, ledger crate, capture date, scope,
then `provisional` and `client below minimum` when they apply), then one row per
scenario: `scenario`, `n`, `calls`, `ops`, `intents`, `nodes`, `proof` and
`balancing` (bytes each term added, `-` when not added), `est size` (`nodes` and
`est size` as the limits read them), `binding`, `used`, `fits`, `txs/block`,
`block bound`, `ops/block`.

`cost` prints the transaction as read, a `proof term:` and a `balancing term:`
line, then one row per limit.

## Snapshot

JSON, written by `update`. Numbers only:

- `contract`, `paramsIdentity`, `toolchain`.
- `scenarios[]`: `name`, `series`, `n`, `calls`, `ops`, `conflict`, and `measured`
  (`cost`, `serializedLen`, `declaredNodes`, `timeToDismiss`).
- `networks[].scenarios[]`: `fits`, `binding`, `txsPerBlock`, `blockBinding`,
  `opsPerBlock`.
- `networks[].series[]`: `maxN`, `basis` (`measured`, `fit` or `none`), `binding`.

Comparison is exact, except for `measured.serializedLen` and
`measured.cost.blockUsage`, which jitter by a few bytes between builds. Those
two may differ by up to `--size-tolerance` bytes (default 32).
`--size-tolerance 0` compares them exactly. `txsPerBlock`, `opsPerBlock` and a
fit-based `maxN` follow `blockUsage` and are compared exactly, so a scenario on a
block-count boundary can flip between builds. `--size-tolerance` does not absorb
that.

## Capacity model

- Each transaction is measured once with the profile's parameters. The params
  identity hashes the fields the cost and the transcript partitioning read
  (`cost_model`, `block_limits`, both time-to-dismiss limits), so fee prices and
  other moving fields do not change it.
- Per-transaction limits: declared nodes against the node cap; estimated size
  against `transaction_byte_limit`; each cost dimension against the block limits;
  time to dismiss against `max(per_byte * size, min)`; weight against the
  per-extrinsic ceiling and the Normal class's block weight; estimated size
  against the Normal class's block length. Comparisons are inclusive.
- Dispatch weight is the largest normalized cost dimension times the weight scale,
  rounded up as the node does, plus the fixed extra weight. The per-extrinsic
  ceiling reads it. The block total adds the base extrinsic weight per
  transaction, as frame_system's `CheckWeight` does.
- The binding limit has the highest used/allowed ratio.
- Per block: the smallest of the weight, length and cumulative ledger block-limit
  bounds; 1 for a `serial` scenario; 0 for one that fails a per-transaction limit.
  Operations per block are transactions per block times `ops`.
- Series: a least-squares line per metric predicts the largest `n` per limit. A
  measured boundary (a fitting and a failing size) wins over the prediction.
- Sizes are the ledger's estimate of the proven transaction, not the unproven bytes.
  For an unproven transaction the ledger assumes 4,832 bytes per contract call proof
  and per Zswap proof and 2,912 per Dust spend proof, and counts no proof encoding.
  The proof term adds `call_bytes` per call and `builtin_bytes` per built-in proof,
  counted in the transaction, to the estimated size and to `blockUsage`, and so to
  everything that reads them: the time-to-dismiss allowance, weight, block length
  and the block counts. A series adds it as a line over its members.
- The balancing term adds `nodes` and `cost` once and `bytes` to the estimated
  size. Balancing also grows every intent's binding commitment, so each intent
  after the first adds `further_intent_bytes` to the size and to `blockUsage`,
  counted in the transaction. A series adds this as a line over its members too.

## Scope and `n/a`

- `balanced`: the profile's balancing term (one intent holding one dust spend,
  plus each further intent's larger binding commitment) is added to the
  transaction before the limits are read.
- `contract-only`: the profile does not know the balancing term, so every result
  covers the contract's transaction alone.
- `as-submitted`: the transaction is already balanced; its numbers are read as
  they are.
- The proof term applies to an unproven transaction in every scope. A proven or
  balanced transaction holds its proofs and gets none. A profile without the term
  leaves the ledger's estimate as it is and reports the term `unknown`.
- `n/a`: the limit or bound reads a profile field that is unknown. It neither
  fails nor binds.

## Known limitations

- The proof term is measured on V3 contract call proofs of two circuits, which
  both serialized to 5,395 bytes. A circuit whose proof has another size is
  under- or overcounted by the difference per call. Zswap input and transient
  proofs were not captured.
- Proving can pad a call's transcript. One circuit's single call gained a 10-byte
  noop, two DAG nodes and 16,001,011 ps of compute time when proved; the term does
  not model this.
- The balancing term is the conservative end of the measured mints; its node count
  varied from +8 to +10 and its one-intent size by about 20 bytes between runs. Its
  per-intent part was measured on one-call intents, up to 41 per transaction.
