# @openzeppelin/compact-deployer

```bash
compact-deploy Token --network local
```

> **Status: developer-preview, testnet only.** Verified on local devnet + preview. Preprod blocked ([Known issues](#known-issues-may-2026)). Mainnet unsupported: unaudited, no hardware signer, no multisig, no tx retry, no upgrade tooling. See [Roadmap](#roadmap--todo).

## Quick start

1. Compile your contract with `compact-compiler` so artifacts land under `src/artifacts/<Name>/`.
2. Drop a `compact.toml` at your repo root (see [Sample config](#sample-config)).
3. Generate a signing key per contract: `head -c 32 /dev/urandom | xxd -p -c 32 > deploy/Token.signingkey`.
4. Run:
   ```bash
   compact-deploy Token --network local
   ```

The deploy result lands in `deployments/compact/<network>.json`.

## CLI

```
compact-deploy <Contract>
  --network <name>          required unless [profile].default_network is set
  --config <path>           default: walk up from CWD for compact.toml
  --seed-file <path>        seed override (raw hex or BIP39 mnemonic, one line)
  --proof-server <url>      override [networks.X].proof_server
  --sync-timeout <seconds>  max wait for wallet to reach chain tip (default 600)
  --no-cache                ignore on-disk wallet-state cache; force fresh sync
  --seed-cache-from-dust <path>      import a pre-warmed dust state file into .states/
  --seed-cache-from-shielded <path>  import a pre-warmed shielded state file into .states/
  --dry-run                 load, validate, build providers, log plan, DO NOT submit
  --json                    single JSON object on stdout (machine-readable)
  -v, --verbose             pino debug logs to .compact/logs/<timestamp>.log
  -h, --help                --version
```

Exit codes: `0` ok · `2` config error · `3` wallet error · `4` provider unreachable · `5` deploy tx failed · `1` unexpected.

## Deploying to real networks (preprod, preview, testnet)

> Preprod is blocked on an upstream wallet-SDK bug. Use `--network preview`. See [Known issues](#known-issues-may-2026).

- **First sync is slow** (~3 min on preview, 30–60 min on preprod from genesis). Cache makes reruns near-instant.
- **Bump sync timeout**: `--sync-timeout 3600` (default 10 min).
- **Bump Node heap** for long-history chains: `NODE_OPTIONS="--max-old-space-size=8192"`.
- **Tip gate is tolerant**: sync completes once every sub-wallet is within 50 events of the tip, not at an exact gap of 0. On a live network the global dust stream advances continuously, so an exact-match gate would never fire.
- **Seed source**: `--seed-file`, `MN_DEPLOYER_SEED`, or `[wallet].keystore`. The `wallet = { source = "local" }` shorthand is dev-preset only.

## Wallet cache

After each successful sync the deployer writes `<cwd>/.states/<network>-<seed-hash>-<kind>.gz` (one file per shielded / dust sub-wallet). Next run restores from it instead of re-syncing from genesis.

- Contents: gzipped sub-wallet state (UTXOs, checkpoint). No private keys (re-derived from seed each run).
- Keyed by SHA-256(seed) + network ID, so `local` vs `preprod` keep separate caches.
- Bust it: `--no-cache` (force fresh) or `rm -rf .states/`. Auto-falls-back on corrupt or version-mismatched files.
- Best-effort writes; never block a deploy. Concurrent runs against the same seed race. Don't.
- `.states/` is gitignored.

### Importing a pre-warmed state file

If cold sync OOMs on preprod (the known upstream bug) and you already have a `wallet.serializeState()` snapshot from a prior session, drop it in with:

```
compact-deploy <Contract> --network preprod \
  --seed-cache-from-dust /path/to/state.json \
  --seed-cache-from-shielded /path/to/shielded.json   # optional
```

- Accepts either raw JSON (the direct `serializeState()` output) or its gzipped copy. Gzip is detected by magic bytes.
- The file is renamed to the seed-derived cache name and dropped into `.states/`.
- **The previous cache (if any) is preserved at `<target>.gz.bak`** — never deleted, never overwritten by the import. To roll back from a bad import, `mv .states/<target>.gz.bak .states/<target>.gz`.
- The write itself is atomic: payload lands in `<target>.gz.tmp` first, then is renamed over `<target>.gz`. A mid-write crash can never leave the live cache half-overwritten.
- Restore failure (e.g. schema mismatch) falls through to the normal "fresh sync from genesis" path with a `warn` log — so the deploy still completes if the import doesn't take.
- Ignored under `--no-cache` (with a warning), since load is disabled in that mode.

## Wallet seed resolution

Precedence, first non-null wins:

1. `--seed-file <path>`
2. `MN_DEPLOYER_SEED` env var (hex or BIP39 mnemonic)
3. `[wallet].keystore` (encrypted JSON, passphrase prompted)
4. `--network local` only: built-in prefunded standalone seed at `[networks.local].wallet.index` (0..3)

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
```

`proof_server`: a URL pins the server; `"auto"` spawns a `testcontainers`-managed proof-server container for the duration of the deploy; omitting it falls back to the env var `PROOF_SERVER_PORT` then to `http://127.0.0.1:6300`.

## Keystore format

`compact-deploy` reads/writes a JSON keystore with the Ethereum V3 shape (scrypt + AES-128-CTR) but with `version: "midnight-1"` so other tooling does not silently mis-read it as an Ethereum key. The encrypted secret is a 32-byte Midnight wallet seed (hex).

## Known issues (May 2026)

1. **Preview endpoints null-routed.** `rpc.preview.midnight.network` and `indexer.preview.midnight.network` resolve to `0.0.0.0` on the authoritative AWS Route 53 nameservers for `midnight.network` (verified against Google, Cloudflare, and Quad9). Preview was alive on 2026-05-22, broken on 2026-05-24. Blocks every consumer of testkit-js's `PreviewTestEnvironment`. File at [midnightntwrk/servicedesk](https://github.com/midnightntwrk/servicedesk/issues/new?template=bug-report.yml). **Workaround:** none on public testnet. `make env-up` (local standalone) is the only working target until Midnight restores the endpoints.

2. **Preprod blocked: `Wallet.Sync: Could not deserialize Ledger Event` on `DustSpendProcessed`.** Dust sync aborts mid-stream on a `DustSpendProcessed` event whose `midnight:event[v9]:`-prefixed `raw` bytes fail `effect/Schema` parsing. The thrown `Wallet.Sync` corrupts `DustLocalState`. The next `walletBalance()` call hits `RuntimeError: unreachable` in the ledger WASM. Two independent runs, two different event IDs: 2026-05-22 id **565,975** (confirmed in Midnight dev Discord by `Knife`); 2026-05-24 id **571,224** with `maxId` 676,018. Affected stack: `wallet-sdk-dust-wallet@4.0.0`, `ledger-v8@8.0.3`, `testkit-js@4.1.0`. File at [midnightntwrk/midnight-wallet](https://github.com/midnightntwrk/midnight-wallet/issues/new). Distinct from [#361 `InvalidDustSpendProof`](https://github.com/midnightntwrk/midnight-wallet/issues/361), which is a chain-side tx rejection (this bug is client-side event ingest). **Workaround:** none. Preview is also down (see #1). Local standalone is the only working target today.

3. **Faucet is manual.** The deployer never hits a faucet. Fund the wallet's `unshielded` address (logged at startup) via the official Midnight faucet site or Discord bot before running.

4. **Dust fee overhead default breaks faucet wallets.** testkit-js default `additionalFeeOverhead` is `5e20` vs a faucet wallet's `~3e15` dust → `Insufficient Funds: could not balance dust`. Deployer overrides to `5e14` for non-mainnet. Library users constructing their own provider must mirror this.

5. **Long-history dust sync exhausts default Node heap.** The deployer now raises the dust/shielded sync batch size (`batchUpdates = { size: 5000, … }`) so the replay no longer OOMs mid-stream on `wallet-sdk-dust-wallet@4.0.0` ([midnightntwrk/midnight-wallet#425](https://github.com/midnightntwrk/midnight-wallet/issues/425)). The restored dust tree plus shielded trial-decryption can still spike past V8's ~2 GB default old-space on a first preprod sync, so set `NODE_OPTIONS="--max-old-space-size=8192"` for that run. Cache fixes subsequent runs.

## Programmatic API

```ts
import { deploy } from "@openzeppelin/compact-deployer";

const result = await deploy({
  contract: "Token",
  network: "local",
  configPath: "./compact.toml",
});
console.log(result.address);
```
