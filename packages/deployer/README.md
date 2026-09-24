# @openzeppelin/compact-deployer

```bash
compact-deploy Token --network local
```

> **Status: developer-preview, local standalone only.** No public network runs the Ledger v9 stack yet. Mainnet unsupported: unaudited, no hardware signer, no multisig, no tx retry, no upgrade tooling.

## Requirements

- Node.js >= 24. The deployer uses `await using` / `AsyncDisposableStack`.

## Quick start

1. Compile your contract with `compact-compiler` so artifacts land under `src/artifacts/<Name>/`.
2. Drop a `compact.toml` at your repo root (see [Sample config](#sample-config)).
3. Generate a signing key per contract: `head -c 32 /dev/urandom | xxd -p -c 32 > deploy/Token.signingkey`.
4. Run:
   ```bash
   compact-deploy Token --network local
   ```

The deploy result lands in `deployments/compact/<network>.json`.

## Install & run

The `compact-deploy` bin ships in `@openzeppelin/compact-cli`. Install it as a dev dependency of the project that holds your compiled artifacts:

```bash
npm i -D @openzeppelin/compact-cli         # or pnpm/yarn
npx compact-deploy Token --network local   # resolves the local install
```

Install it locally for any real deploy. The deployer and your artifacts must share one physical `@midnight-ntwrk/compact-runtime` copy, and an ephemeral `npx @openzeppelin/compact-cli …` fetches its own, failing the submit with `expected instance of ContractMaintenanceAuthority`. Ephemeral is fine for `--help`, `--version` and `--dry-run`.

## Supported stack

The deployer pins one Midnight stack, and artifacts have to be compiled against a matching compiler.

| Component | Version |
|---|---|
| `@midnight-ntwrk/compact-runtime` | 0.19.0 |
| `@midnightntwrk/ledger-v9` | 1.0.0-rc.5 |
| `@midnight-ntwrk/compact-js` | 2.5.5-rc.8 |
| `@midnight-ntwrk/midnight-js-*` | 5.0.0-beta.7 |
| `@midnight-ntwrk/testkit-js` | 5.0.0-beta.7 |
| `@midnightntwrk/wallet-sdk-facade` | 5.0.0-beta.2 |
| Compact compiler | 0.34.0 |

Compile with `compact compile +0.34.0`. An older artifact fails at submit with `Version mismatch`.

The ledger and the wallet SDK sit under the `@midnightntwrk` scope, no hyphen. Everything else keeps `@midnight-ntwrk`.

yarn and pnpm need one pin, because `compact-js` declares the ledger as a range and a second ledger copy breaks every deploy:

```json
"resolutions": {
  "@midnightntwrk/ledger-v9": "1.0.0-rc.5"
}
```

(`pnpm.overrides` for pnpm.) Nothing else in the stack floats.

## CLI

```
compact-deploy <Contract>
  --network <name>          required unless [profile].default_network is set
  --config <path>           default: walk up from CWD for compact.toml
  --seed-file <path>        seed override (raw hex or BIP39 mnemonic, one line)
  --proof-server <url>      override [networks.X].proof_server
  --sync-timeout <seconds>  max wait for wallet to reach chain tip (default 600)
  --tx-timeout <seconds>    max wait per tx finalization, indexer catch-up, and dust settle (default 600)
  --sync-batch-size <n>     dust/shielded sync batch size (default 5000)
  --circuits-per-tx <n>     verifier keys per tx; splits a large deploy (default: one tx)
  --no-cache                ignore on-disk wallet-state cache; force fresh sync
  --force                   replace a pending or partial deploy record for this contract
  --seed-cache-from-dust <path>      import a pre-warmed dust state file into .states/
  --seed-cache-from-shielded <path>  import a pre-warmed shielded state file into .states/
  --seed-cache-from-unshielded <path> import a pre-warmed unshielded state file into .states/
  --dry-run                 load, validate, build providers, log plan, DO NOT submit
  --json                    single JSON object on stdout (machine-readable)
  -v, --verbose             pino debug logs to .compact/logs/<timestamp>.log
  -h, --help                --version
```

Exit codes: `0` ok · `2` config error (includes a pending or partial deploy record without `--force`) · `3` wallet error · `5` deploy tx failed or not confirmed · `6` deployments ledger unreadable or unwritable · `7` the deploy tx was refused as too large at the configured or minimum fragment size · `8` fragmented deploy incomplete · `1` unexpected.

A deploy writes `status: "pending"` (address, txId) as soon as the node accepts the tx, then `status: "confirmed"` (txHash, blockHeight) on finalization. A dropped connection or `--tx-timeout` leaves the pending record in place; the next deploy of that contract refuses until you check the tx on chain and pass `--force`.

## Large contracts

The node rejects a deploy tx above the per-block extrinsic limit with `1010: Invalid Transaction: Transaction would exhaust the block limits`. Weight grows with circuit count, so past roughly 15 circuits a single-tx deploy stops landing.

`--circuits-per-tx <n>` (or `[contracts.X].circuits_per_tx`) splits it: fragment 0's verifier keys ride the deploy tx, each further fragment is one `MaintenanceUpdate` batching `VerifierKeyInsert`s.

- Left unset, the deployer submits the largest batch it can and halves on a refusal, down to a single circuit. There is no pre-flight weight check.
- Set at or above the circuit count, it pins a single-tx deploy and disables halving: a refusal is exit 7, never a split.
- A size found by halving is remembered in memory: later deploys of the same artifact on the same network, in the same process, start there. A set budget and a resume ignore it.
- Fragments are ordered by sorted circuit name, so a rerun rebuilds the same plan.
- One `deploy()` call does the deploy, every insert, and a byte-for-byte check of every on-chain key against the artifact. Only that check writes `confirmed`.
- Between fragment 0 landing and the last insert the contract is live with a subset of its circuits, ordered by name rather than by dependency. Keep every circuit safe to call alone, or hold traffic until the deploy confirms.
- A constructor that creates or spends a Zswap coin cannot be split: exit 2.
- A committee with a threshold above 1 is refused, since the deployer holds one key: exit 2.

### Resuming

A split deploy writes `status: "partial"` (address, txId, `circuitsOnChain`, `circuitsPending`). Re-running the same command resumes it from chain state, not from the record.

- Resume is refused with exit 2 unless the recorded address exists, its committee holds this signing key, and every on-chain key matches the artifact.
- Exit 8 means the deploy tx was not seen within `--tx-timeout`. It may still be landing, so check the address on an explorer before reaching for `--force`.
- If every circuit is on chain but the indexer never serves the deploy tx, copy `txHash` and `blockHeight` from an explorer into the record and re-run. That confirms without a new transaction.
- `--force` on a `partial` head abandons it and deploys a new contract at a new address.
- A resume stores the signing key if the private-state store lacks it. It never restores `initialPrivateState`, which exists only inside the original constructor run.
- The guard cannot tell two deploys of the same artifact with the same key apart. Do not hand-edit a `partial` record's `address`, or a sibling deploy will receive this run's remaining keys.

Results carry `fragments` (transactions the address has taken; `0` on a dry-run) and `circuits` (keys verified on chain). A `--json` failure adds `address`, `circuitsOnChain`, `circuitsPending`, and the failed insert's `txId`.

## Deploying to real networks (preprod, preview, testnet)

> Nothing public is deployable today: preprod is still on the v8 ledger and preview is null-routed. Local standalone (`make env-up`) is the only working target. The rules below apply once a public network moves to v9.

- **First sync is slow** on a long-history chain, tens of minutes from genesis. Cache makes reruns near-instant, but raise `--sync-timeout` for the first run.
- **Bump the Node heap** for long-history chains: `NODE_OPTIONS="--max-old-space-size=8192"`.
- **Lower `--sync-batch-size`** on a memory-constrained host. Larger replays a long dust history faster but costs memory per batch.
- **Persist the sync knobs**: `sync_timeout` and `sync_batch_size` under `[networks.X]`. Precedence is CLI > TOML > default.
- **The tip gate is tolerant**: sync completes within 50 events of the tip. On a live network the dust stream advances continuously, so an exact gate would never fire.
- **Seed source**: `--seed-file`, `MN_DEPLOYER_SEED`, or `[wallet].keystore`. The `wallet = { source = "local" }` shorthand is dev-preset only.

## Wallet cache

After each successful sync the deployer writes `<compact.toml dir>/.states/<network>-<seed-hash>-<kind>.gz`, one file per shielded / dust / unshielded sub-wallet. The next run restores from it instead of re-syncing from genesis.

- Contents: gzipped sub-wallet state (UTXOs, checkpoint). No private keys; those are re-derived from the seed each run.
- Keyed by SHA-256(seed) + network ID, so `local` and `preprod` keep separate caches.
- Bust it with `--no-cache` or `rm -rf .states/`. Corrupt or version-mismatched files fall back to a fresh sync.
- Writes are best-effort and never block a deploy.
- Resolved against the `compact.toml` directory, not the shell CWD. Same for the LevelDB private-state store (`<compact.toml dir>/midnight-level-db/`).
- Run one `compact-deploy` at a time per project. A second concurrent run fails on the LevelDB lock, and two runs on one seed race the cache.
- Library callers running several deploys in one process must pass their own `privateStateProvider`. The default LevelDB store holds its lock until the process exits.
- `.states/` is gitignored.

### Importing a pre-warmed state file

Drop in a `wallet.serializeState()` snapshot from a prior session:

```
compact-deploy <Contract> --network preprod \
  --seed-cache-from-dust /path/to/state.json \
  --seed-cache-from-shielded /path/to/shielded.json \
  --seed-cache-from-unshielded /path/to/unshielded.json
```

- The dust file is the one that matters on a long-history chain. The other two are optional.
- Raw JSON or gzipped, detected by magic bytes.
- The previous cache is kept at `<target>.gz.bak`, never deleted. Roll back with `mv .states/<target>.gz.bak .states/<target>.gz`.
- The write is atomic: `<target>.gz.tmp` first, then renamed over `<target>.gz`.
- A restore failure warns and falls through to a fresh sync, so the deploy still completes.
- Ignored under `--no-cache`.

## Wallet seed resolution

Precedence, first non-null wins:

1. `--seed-file <path>`
2. `MN_DEPLOYER_SEED` env var (hex or BIP39 mnemonic)
3. `[wallet].keystore` (encrypted JSON, passphrase prompted)
4. `--network local` only: built-in prefunded standalone seed at `[networks.local].wallet.index` (0..4)

## Sample config

```toml
[profile]
default_network = "local"
artifacts_dir   = "src/artifacts"
deployments_dir = "deployments/compact"

# ---------- Networks ----------
[networks.local]
network_id   = "undeployed"
indexer      = "http://127.0.0.1:8088/api/v3/graphql"
indexer_ws   = "ws://127.0.0.1:8088/api/v3/graphql/ws"
node         = "http://127.0.0.1:9944"
node_ws      = "ws://127.0.0.1:9944"
proof_server = "http://127.0.0.1:6300"
wallet       = { source = "local", index = 0 }

[networks.preview]
network_id   = "preview"
indexer      = "https://indexer.preview.midnight.network/api/v4/graphql"
indexer_ws   = "wss://indexer.preview.midnight.network/api/v4/graphql/ws"
node         = "https://rpc.preview.midnight.network"
node_ws      = "wss://rpc.preview.midnight.network"
proof_server = "auto"
explorer     = "https://preview.midnightexplorer.com"

[networks.preprod]
network_id   = "preprod"
indexer      = "https://indexer.preprod.midnight.network/api/v4/graphql"
indexer_ws   = "wss://indexer.preprod.midnight.network/api/v4/graphql/ws"
node         = "https://rpc.preprod.midnight.network"
node_ws      = "wss://rpc.preprod.midnight.network"
proof_server = "auto"
explorer     = "https://preprod.midnightexplorer.com"
sync_timeout    = 5400   # seconds; overridden by --sync-timeout
sync_batch_size = 5000   # dust/shielded batch; overridden by --sync-batch-size

# ---------- Wallet (non-local) ----------
[wallet]
keystore = "./deployer.keystore.json"

# ---------- Contracts ----------
[contracts.Token]
artifact           = "src/artifacts/Token/Token"
private_state_id   = "tokenPrivateState"
init_private_state = { file = "./deploy/Token.private-state.json" }
args               = ["MyToken", "MTK", 18]
signing_key_file   = "./deploy/Token.signingkey"

[contracts.Vault]
artifact         = "src/artifacts/Vault/Vault"
args             = []
signing_key_file = "./deploy/Vault.signingkey"
# Split this deploy into fragments of 8 verifier keys. See "Large contracts".
circuits_per_tx  = 8
```

`proof_server`: a URL pins the server; `"auto"` spawns a `testcontainers`-managed proof-server container for the deploy; omitting it falls back to `PROOF_SERVER_PORT`, then to `http://127.0.0.1:6300`.

`"auto"` needs Docker and boots the `proof-server.yml` shipped in this package, pinning `midnightntwrk/proof-server:9.0.0-rc.6`. To boot a different image, put your own `proof-server.yml` in the directory you run `compact-deploy` from; it wins over the packaged one.

### Patterns

One `[contracts]` entry can cover many contracts. A key is one of:

- `Token`: exact, that contract only.
- `"Mock*"`: a name pattern (holds `*`, `?`, `[` or `{`), matched against the contract name.
- `"**/test/mocks/*"`: a directory pattern (holds `/`), matched against the contract's source path under `[profile].src_dir`, `.compact` included. The source of `<name>` is the unique `<src_dir>/**/<name>.compact`, skipping `node_modules` and dot-directories. A second match is an error.

Every matching pattern applies in file order, a later one overriding an earlier one field by field. The exact entry applies last. `{name}` in any string value expands to the contract name, and `artifact` defaults to it. `runDeploy(Contract)` searches exact keys only.

```toml
[profile]
src_dir = "contracts/src"

[contracts."**/test/mocks/*"]
signing_key_file = "./deploy/{name}.signingkey"

# Inherits signing_key_file from the pattern above.
[contracts.MockToken]
args = ["MyToken", "MTK", 18]
```

## Keystore format

An Ethereum V3 JSON keystore (scrypt + AES-128-CTR) tagged `version: "midnight-1"`, so other tooling does not mis-read it as an Ethereum key. The encrypted secret is a 32-byte Midnight wallet seed (hex).

## Known issues

1. **Preprod runs the v8 ledger.** Its transactions carry the `midnight:transaction[v9]` header tag, which `@midnightntwrk/ledger-v9` rejects on deserialize. **Workaround:** none until preprod upgrades; use local standalone.

2. **Preview endpoints are null-routed.** `rpc.preview` and `indexer.preview` resolve to `0.0.0.0`, which blocks every consumer of testkit-js's `PreviewTestEnvironment`. **Workaround:** none on public testnet; use local standalone.

3. **The faucet is manual.** Fund the wallet's `unshielded` address, logged at startup, before running.

4. **Dust fee overhead breaks faucet wallets.** testkit-js defaults `additionalFeeOverhead` to `5e20` against a faucet wallet's `~3e15` dust, giving `Insufficient Funds: could not balance dust`. The deployer overrides to `5e14`; library users building their own provider must mirror that.

5. **Long-history dust sync exhausts the default Node heap.** The deployer raises the sync batch size to 5000 ([midnight-wallet#425](https://github.com/midnightntwrk/midnight-wallet/issues/425)), but a first sync on a long-history chain can still pass V8's ~2 GB default old-space. Set `NODE_OPTIONS="--max-old-space-size=8192"` for that run; cache fixes the rest.

6. **The root `@midnightntwrk/ledger-v9` resolution is load-bearing.** `compact-js` declares it as a range, so without the pin yarn nests a second ledger copy and deploys fail. Do not drop it on a bump.

7. **`@midnight-ntwrk/compact-runtime` resolves to two copies**, `0.19.0-rc.0` under `compact-js` and `midnight-js-protocol` against `0.19.0` everywhere else. The integration suite deploys on that tree, including the pruned constructor path through `compact-js`. Forcing one `0.19.0` copy with a resolution also deploys, the split path included.

## Programmatic API

The package has no barrel entrypoint. Each module is its own subpath export, so an import names the module it comes from and pulls in only that module.

| Subpath | Exports |
|---|---|
| `/run-deploy` | `runDeploy`, `constructorArgs`, `ConstructorArgsOf`, `RunDeployOptions` |
| `/deployer` | `Deployer`, `DeployerOptions`, `DeployResult` |
| `/deployments` | `Deployments`, `DeploymentRecord` (`PendingDeploymentRecord` \| `PartialDeploymentRecord` \| `ConfirmedDeploymentRecord`, discriminated on `status`), `DeploymentsFile`, `DeploymentsHistory` |
| `/errors` | `DeployError` and every typed subclass |
| `/config/compact-config` | `CompactConfig` |
| `/config/schema` | `ContractConfig`, `NetworkConfig`, `Profile`, `WalletConfig` |
| `/loaders/args` · `/loaders/argv` · `/loaders/artifact` · `/loaders/init-state` · `/loaders/signing-key` | `ConstructorArgs`, `parseDeployArgv`, `Artifact`, `InitialPrivateState`, `SigningKey` |
| `/providers/proof-server` | `ProofServer` |
| `/wallet/handler` · `/wallet/keystore` · `/wallet/seeds` | `WalletHandler`, `Keystore`, `classifySeed`, `localPrefundedSeed` |

Curried form. Pass the compiled `Contract` class and the constructor args become typed parameters:

```ts
import { runDeploy } from "@openzeppelin/compact-deployer/run-deploy";
import { Contract } from "./src/artifacts/Token/contract/index.js";

const result = await runDeploy(Contract, { network: "local" })(
  "OpenZeppelin Token", // _name: string
  "OZE",                // _symbol: string
  18n,                  // _decimals: bigint
);
console.log(result.address);
```

Options-object form. Name the contract as it appears in `compact.toml`, with args from the TOML or inline:

```ts
import { runDeploy } from "@openzeppelin/compact-deployer/run-deploy";

const result = await runDeploy({
  contract: "Token",
  network: "local",
  configPath: "./compact.toml",
  args: ["OpenZeppelin Token", "OZE", 18n],
});
console.log(result.address);
```

Every option has a `process.argv` default (`--network`, `--config`, `--dry-run`, …), so the same script works with flags at the call site. On failure `runDeploy` sets `process.exitCode` and rethrows; it never calls `process.exit`, so catch it if you want that code to reach the shell.

Three options suit a caller that deploys many contracts from code, such as a test harness. `Deployer.prepare` and `runDeploy` both take them, with no argv flag:

- `initialPrivateState` and `witnesses` override `[contracts.X].init_private_state` and `[contracts.X].witnesses`. A `private_state_id` and an initial private state come together: `prepare` throws `ConfigError` when one lacks the other.
- `record: false` skips the deployments ledger. Nothing is read or written, so every deploy is fresh and `deploymentsFile` is `''`.

```ts
import { Deployer } from "@openzeppelin/compact-deployer/deployer";

await using deployer = await Deployer.prepare({
  contract: "MockToken",
  network: "local",
  logger,
  walletProvider,       // one wallet shared across deploys
  privateStateProvider, // e.g. testkit-js inMemoryPrivateStateProvider()
  initialPrivateState: { secretKey },
  witnesses,
  record: false,
});
const { address } = await deployer.deploy();
```
