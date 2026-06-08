# TokenExample — `compact-deployer` walkthrough with a rich constructor

Deploys a small ERC20-flavoured contract built on the OpenZeppelin Compact `FungibleToken` module. The example shows two ways to drive the deployer:

1. **A TS deploy script** that imports `runDeploy()` from `@openzeppelin/compact-deployer` and passes constructor args inline as native JS values.
2. **The `compact-deploy` CLI** binary from `@openzeppelin/compact-cli`, which reads args from a `.args.mjs` module referenced in `compact.toml`.

Both end up calling the same deployer code; pick whichever fits your workflow.

The constructor exercises every common Compact primitive type:

| Constructor arg | Compact type | JS type |
|---|---|---|
| `_name` | `Opaque<"string">` | `string` |
| `_symbol` | `Opaque<"string">` | `string` |
| `_decimals` | `Uint<8>` | `number` |
| `_treasury` | `Bytes<32>` | `Uint8Array(32)` |
| `_maxSupply` | `Uint<128>` | `BigInt` |
| `_feeBps` | `Uint<32>` | `number` |
| `_quorum` | `Uint<64>` | `BigInt` |
| `_isMintable` | `Boolean` | `boolean` |
| `_tag` | `Bytes<8>` | `Uint8Array(8)` |

## What's in here

```
fungible-token/
  contracts/
    TokenExample.compact            wrapper with the rich constructor
    token/FungibleToken.compact     vendored from compact-contracts
    security/Initializable.compact  vendored from compact-contracts
    utils/Utils.compact             vendored from compact-contracts
  artifacts/TokenExample/           compiler output (gitignored; you generate this)
  compact.toml                      deployer config (3 networks defined)
  deploy/
    deployTokenExample.ts           the TS deploy script (path #1)
    TokenExample.args.mjs           args module read by the CLI (path #2)
    TokenExample.signingkey         you generate this (gitignored)
  deployments/                      deployer writes here on success (gitignored)
  package.json                      a workspace member: depends on
                                    @openzeppelin/compact-deployer +
                                    compact-cli via `workspace:^`
```

## Prerequisites

- Node 24+
- Docker (for the local Midnight stack)
- A one-time root setup: `yarn install && yarn build` from the repo root. This is a yarn workspace, so binaries like `compact-compiler` and `compact-deploy` resolve automatically inside this folder.

## Run it

```bash
cd examples/fungible-token

# 1. Compile the contract — artifacts/ is gitignored, so generate it first.
yarn compile

# 2. Generate a per-contract signing key.
head -c 32 /dev/urandom | xxd -p -c 32 > deploy/TokenExample.signingkey

# 3. Start the local Midnight stack (from the repo root).
make env-up

# 4. Pick a path — see below.
```

### Path 1 — TS deploy script (args inline)

```bash
yarn deploy:local          # node deploy/deployTokenExample.ts
yarn deploy:preview        # …--network preview --sync-timeout 1800
yarn deploy:preprod        # …--network preprod --sync-timeout 7200
```

[`deploy/deployTokenExample.ts`](deploy/deployTokenExample.ts) is the whole script:

```ts
import { runDeploy } from '@openzeppelin/compact-deployer';
import { Contract } from '../artifacts/TokenExample/contract/index.js';

await runDeploy(Contract)(
  'OpenZeppelin Example Token',         // editor: "_name_2: string"
  'OZE',                                // editor: "_symbol_2: string"
  18n,                                  // editor: "_decimals_2: bigint"
  new Uint8Array(32).fill(0xab),
  1_000_000_000_000_000_000_000_000n,
  250n, 7n, true,
  new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe]),
);
```

The curried form names the contract once via the imported `Contract` class — the deployer matches it to `[contracts.TokenExample]` in `compact.toml` by class identity, so no string repetition. Constructor args are typed function parameters: each comma triggers TypeScript signature help showing the next param's name and type.

To pass extra deploy options (network, dry-run, …), supply them as the second arg:

```ts
await runDeploy(Contract, { network: 'preview', dryRun: true })(
  'OpenZeppelin Example Token', 'OZE', 18n, /* … */
);
```

`runDeploy()` parses `--network`, `--dry-run`, `--sync-timeout`, `--no-cache`, `--seed-file`, `--proof-server`, `--config`, `--json`, and `-v` / `--verbose` from `process.argv` as defaults. Explicit options on the call win.

Alternative call shapes:
- `runDeploy({ contract: 'TokenExample', args: [...] })` — options-object form. Use when args come from `compact.toml`, when one `compact.toml` has multiple entries for the same Contract class, or for programmatic flows.
- `runDeploy({ contract: 'TokenExample', args: constructorArgs(Contract, ...) })` — keeps the per-comma editor hints inside an options-object call.
- Named-object args (`args: { _name: '…', … }`) — full autocomplete but requires a hand-written interface; see [logs/feature-compactc-export-constructor-args-interface.md](../../logs/feature-compactc-export-constructor-args-interface.md) for the upstream fix that would eliminate the hand-writing.

### Path 2 — `compact-deploy` CLI (args in a separate module)

```bash
yarn cli:local             # compact-deploy TokenExample --network local
yarn cli:preview           # compact-deploy TokenExample --network preview …
yarn cli:preprod           # compact-deploy TokenExample --network preprod …
```

`compact.toml` already points at the args module:

```toml
[contracts.TokenExample]
artifact         = "TokenExample"
signing_key_file = "deploy/TokenExample.signingkey"
args             = { module = "./deploy/TokenExample.args.mjs", export = "args" }
```

[`deploy/TokenExample.args.mjs`](deploy/TokenExample.args.mjs) exports the same JS values as Path 1. The CLI doesn't need a script — `compact-deploy TokenExample --network <name>` reads everything from `compact.toml`.

### When to pick which

| Picking… | When |
|---|---|
| Path 1 (script) | The deploy logic itself is the moving part. Easy to add post-deploy work (seed state, run callTx, write a custom record) in the same file. |
| Path 2 (CLI) | The deploy logic is fixed and only the args vary per network or per build. Lighter footprint — no JS script to maintain. |

`runDeploy()` actually accepts the same `args` field that you'd put in `compact.toml`, so Path 1 can read from a `.args.mjs` too (drop the `args:` field from the script call and the TOML ref takes over).

## Type-by-type cheat sheet

| Compact | JS |
|---|---|
| `Opaque<"string">` | `string` |
| `Uint<N>` (any width) | `bigint` (use the `n` suffix: `18n`, `250n`). The compiler emits every `Uint<N>` as `bigint`. |
| `Boolean` | `boolean` |
| `Bytes<N>` | `new Uint8Array(N)` of length exactly `N` |
| `Vector<N, T>` | array of length exactly `N` |
| `Maybe<T>` | `{ is_some: true, value: T }` or `{ is_some: false, value: <zero-T> }` |
| `Either<L, R>` | `{ is_left: true, left: L, right: <zero-R> }` or mirror with `is_left: false` |

`Bytes<N>` values must be exactly `N` bytes — neither path pads or truncates.

## Public testnets (preview, preprod)

```bash
yarn deploy:preview   # or yarn cli:preview
yarn deploy:preprod   # or yarn cli:preprod
```

First sync takes a few minutes on preview and 30–60 minutes on preprod (the deployer caches both shielded + dust state under `.states/` so subsequent runs are near-instant).

> Preview and preprod are both blocked upstream right now. See the deployer's "Known issues" section in [`packages/deployer/README.md`](../../packages/deployer/README.md).

## Recompile the contract

If you edit `contracts/TokenExample.compact` (or any vendored file under `contracts/`):

```bash
yarn compile
```

This runs the workspace's `compact-compiler` (from `@openzeppelin/compact-builder`) over `contracts/` and emits a hierarchical artifact tree under `artifacts/`. The `artifacts/` tree is gitignored: regenerate it locally, don't commit it.

## Cleanup

```bash
make env-down                                    # from the repo root
rm -rf .states deployments deploy/TokenExample.signingkey
```

## Where to look next

- [`packages/deployer/README.md`](../../packages/deployer/README.md) — every CLI flag, keystore format, current known-issues list.
- `contracts/token/FungibleToken.compact` — the full ERC20-ish surface this wrapper delegates to (`transfer`, `_mint`, `allowance`, etc.). Wire more circuits into `TokenExample.compact` to expose them.
