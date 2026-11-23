# @openzeppelin/compact-profiler

Capacity profiler for Midnight Compact contract transactions. Two parts:

- A runner library. It executes a compiled contract's circuits in memory, builds one
  unproven ledger transaction per scenario, and writes the transactions plus a manifest.
- A `compact-profile` bin, a launcher for the [`compact-profile`](../../crates/compact-profile)
  Rust binary. The binary re-costs each transaction with the Rust ledger, checks parity with
  the runner's numbers, evaluates every per-transaction limit of a network, counts
  transactions per block, and fails on drift from a committed snapshot.

## Install

```bash
yarn add --dev @openzeppelin/compact-profiler
```

## Example

```ts
import { createProfiler, defaultCaller, runCheck } from '@openzeppelin/compact-profiler';
import { Contract } from './artifacts/MyToken/contract/index.js';

// `domain` and `nonce(i)` stand for the contract's own Bytes<32> arguments.
const me = { bytes: Buffer.from(defaultCaller().coinPublicKey, 'hex') };
const profiler = await createProfiler({
  name: 'MyToken',
  contract: new Contract({}),
  constructorArgs: [domain],
  network: 'mainnet',
  outDir: '.profile',
});
await profiler.scenario('mint', (tx) => tx.call('mint', me, 1000n, nonce(0)));
await profiler.series('mint multi-call', { sizes: [1, 2, 4, 8] }, (tx, n) => {
  for (let i = 0; i < n; i++) tx.call('mint', me, 1000n, nonce(i));
});
await profiler.searchMax('mint max', {}, (tx, n) => {
  for (let i = 0; i < n; i++) tx.call('mint', me, 1000n, nonce(i));
});
const manifest = await profiler.write();
await runCheck({ manifest, networks: ['mainnet', 'preprod'], snapshot: 'profile.snapshot.json' });
```

Run `runCheck` with `update: true` once to write the snapshot, and commit it.

## API

### `createProfiler(options)`

Deploys the contract in memory and reads `network`'s ledger parameters from
`compact-profile params`.

| Option | Default |
| --- | --- |
| `name` | Required; the manifest's `contract` |
| `contract` | Required; a compiled contract instance, `new Contract(witnesses)` |
| `network` | Required; the profile whose parameters partition transcripts |
| `outDir` | Required |
| `constructorArgs` | `[]` |
| `privateState` | Required unless the private state type admits `undefined` |
| `caller` | `defaultCaller().coinPublicKey`, keys from seed sha256(`compact-profiler:caller`) |
| `encryptionPublicKey` | `(coinPublicKey) => defaultCaller().encryptionPublicKey` |
| `contractAddress` | `DEFAULTS.contractAddress`, sha256(`compact-profiler:contract-address`) |
| `toolchain` | Extra manifest entries, such as `{ compactc: '0.36.0' }` |
| `networkId` | `'undeployed'` |
| `time` | `1893456000` (2030-01-01), the block time circuits see, in seconds |
| `ttl` | One hour after `time` |
| `binary`, `profileFile` | See [Where the binary comes from](#where-the-binary-comes-from) |

### `Profiler`

- `scenario(name, [{ conflict, ops }], build)`: one transaction.
- `series(name, { sizes, conflict, ops }, build)`: one transaction per size `n`.
  `ops` is a number or `(n) => number`.
- `searchMax(name, { networks, cap, conflict, ops }, build)`: the largest `n` that fits every
  per-transaction limit on `networks` (default: the profiler's), per `compact-profile cost`.
  Sizes double, then a binary search runs up to `cap` (default 256). Records sizes 1, 2, 4
  and 8 below the maximum, the maximum and the first size over. Returns
  `{ maxN, capped, binding, scenarios }`.
- `apply(build)`: runs calls on the base state without recording a transaction.
- `write()`: writes the manifest, deletes every `.tx` file under `<outDir>/txs` the manifest
  does not list, and returns the manifest's path.

`conflict` defaults to `none`, the optimistic value: copies of the transaction share a block.
`serial` fits one copy per block. A scenario is `serial` when its circuit reads, in-circuit, a
ledger value that another copy of the same transaction writes: a `Counter.read`, a
`Map.lookup`, a cell read. The sample's `incrementFrom` in
[`Counter.compact`](test/fixtures/sample-contracts/Counter.compact) is one.

Every scenario starts from the base state: the deployed state plus every `apply`. A build
receives a `TxBuilder`:

- `call(circuit, ...args)` and `callWith({ caller }, circuit, ...args)` queue a call and
  return a promise of its result. Calls run in order, each on the state the previous one left.
- `contractState` and `privateState` hold the state after the calls awaited so far.

### `runCheck({ manifest, networks, snapshot, update, sizeTolerance, reporter })`

Runs `compact-profile check`, or `update` with `update: true`. Resolves to
`{ exitCode, stdout, stderr }`. A non-zero exit rejects with `ProfileCommandError`, which
carries the same fields and puts both streams in its message. `sizeTolerance` applies to
`check` only and rejects with `update: true`.

`runProfileBinary(args)`, `networkParams(network)` and `costTransaction(tx, network)` run
the binary directly.

## Output

```text
<outDir>/manifest.json
<outDir>/txs/<scenario>.tx
```

Series members are named `<series> n=<n>`. The manifest, the snapshot and the `cost`
report are specified in the [crate README](../../crates/compact-profile/README.md).

## Transaction shape

Each call becomes a single-call transaction with its own intent and Zswap offer, as
midnight-js builds it. A scenario merges them with explicit, ascending segment ids 1 to N.
The SDK's random segment ids made dependent calls fail on a node, so this is the shape that
lands.

## Limitations

- Circuits that spend a shielded coin they did not create in the same call, such as burns of
  an existing coin, cannot be profiled yet. Cross-contract calls are unsupported.
- `serializedLen` and `blockUsage` vary by a few bytes between runs: the ledger draws
  randomness when it builds intents and Zswap outputs, and field elements serialize with
  leading zero bytes dropped. The spread grows with calls (observed: 2 bytes for one mint, 5
  for four, 12 for forty). Every other measured number is stable. `check` allows 32 bytes on
  those two by default, and `runCheck`'s `sizeTolerance` changes that.
- `txsPerBlock`, `opsPerBlock` and a fit-based `maxN` follow `blockUsage` and are compared
  exactly, so a scenario on a block-count boundary can flip between builds. `sizeTolerance`
  does not absorb that.
- The ledger client version fixes the gas a transaction declares, so the numbers change with
  `@midnightntwrk/ledger-v9`'s version. The snapshot records which version built them.

## Peer dependencies

`@midnight-ntwrk/compact-runtime` (`^0.21.0`) and `@midnightntwrk/ledger-v9`
(`^1.0.0-rc.5`). The compiled contract, the runtime and the ledger must resolve to single
copies in your tree. A second `@midnightntwrk/onchain-runtime-v4` breaks instance checks.

A ledger below a network's minimum client version prints one warning; `compact-profile`
labels that network in its report.

## Where the binary comes from

- Prebuilt binaries are attached to the `compact-profiler/v<version>` GitHub release, one
  per target: `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
  `x86_64-apple-darwin`, `aarch64-apple-darwin`.
- The first run downloads the one matching the host, checks its SHA-256 against the
  `checksums.txt` published inside this package, and caches it as
  `compact-profile-<version>-<target>` in `$XDG_CACHE_HOME/compact-profiler` or
  `~/.cache/compact-profiler` on Linux, `~/Library/Caches/compact-profiler` on macOS.
- No prebuilt binary for the host, musl Linux included, is a hard error: build the crate
  with `cargo install --path crates/compact-profile` and set `COMPACT_PROFILE_BINARY`.

| Variable | Effect |
| --- | --- |
| `COMPACT_PROFILE_BINARY` | Run this executable and skip the download. The `binary` option does the same per call. |
| `COMPACT_PROFILE_DOWNLOAD_BASE` | Fetch the asset from this base URL instead of the GitHub release. It is still checked against `checksums.txt`. |

## Requirements

- Node.js >= 24
- Linux with glibc, or macOS; x86_64 or aarch64
