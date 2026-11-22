# Test fixtures

## Regenerate

From the repository root, after `cargo build -p compact-profile`, with the `compact`
CLI on `PATH`:

```sh
COMPACT_PROFILE_BINARY=$PWD/target/debug/compact-profile yarn workspace @openzeppelin/compact-profiler generate:crate-fixtures
COMPACT_PROFILE_BLESS=1 cargo test -p compact-profile --test cli
```

The first command compiles `packages/profiler/test/fixtures/sample-contracts/Mint.compact`
and writes:

- `mint/`: the runner's manifest and transactions, and the snapshot `update` writes.
- `mint-rerun/`: a rebuild of `mint multi-call n=4` whose size differs from the one in `mint/`.
- Each `check-*` case's manifest or snapshot: the base set with one edit.

The second writes each case's `expected.txt` from the binary's output. A rebuild changes
`serializedLen` and `blockUsage` by a few bytes, so the expected tables change with it.

`tests/cli.rs` names the first multi-call size over mainnet's node cap
(`mint-multi-call-n-42.tx`) and the scenario count. Update both when the cap moves.

## Captured, not regenerated

### `params/live-mainnet.bin`

Mainnet's tagged `LedgerParameters`, 791 bytes, read on 2026-11-20 with `state_call
MidnightRuntimeApi_get_ledger_parameters` from the public RPC node (node 2.1.101,
spec_version 2001100). `profiles/mainnet.toml` embeds the same bytes.

### `live/`

Captured on 2026-11-20 on a local dev chain running node 2.1.101. `base` and `preset` are
two token mint circuits from contracts outside this repository. Balancing added one intent
holding one dust spend.

| File | Calls | Form | Client ledger-v9 | Outcome |
|---|---|---|---|---|
| `base-mint-proven.bin` | 1 | proven, 89 nodes | not recorded | balanced into the next file |
| `base-mint-balanced.bin` | 1 | balanced, 98 nodes | not recorded | landed; the indexer returned the same bytes |
| `preset-mint-balanced.bin` | 1 | balanced, 140 nodes | 1.0.2 | landed; the indexer returned the same bytes |
| `base-merged-n40-unproven.bin` | 40 | unproven, 1,002 nodes | 1.0.2 | proven and balanced to 1,010 nodes, landed |
| `base-merged-n41-unproven.bin` | 41 | unproven, 1,025 nodes | 1.0.2 | proven and balanced to 1,034 nodes, rejected on submission (custom error 111) |
| `preset-merged-n29-unproven.bin` | 29 | unproven, 986 nodes | 1.0.2 | not recorded for this build; an earlier build of the same calls, also 986 nodes, landed at 995 balanced |
| `preset-merged-n30-unproven.bin` | 30 | unproven, 1,017 nodes | 1.0.2 | proven and balanced to 1,025 nodes, rejected on submission (custom error 111) |
