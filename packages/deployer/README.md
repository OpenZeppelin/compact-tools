# @openzeppelin/compact-deployer

Forge-style deployer CLI for Midnight Compact contracts.

```bash
compact-deploy Token --network local
```

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
  --skip-faucet             don't call the faucet even if faucet=true
  --dry-run                 load, validate, build providers, log plan, DO NOT submit
  --json                    single JSON object on stdout (machine-readable)
  -v, --verbose             pino debug logs to .compact/logs/<timestamp>.log
  -h, --help                --version
```

Exit codes: `0` ok · `2` config error · `3` wallet error · `4` provider unreachable · `5` deploy tx failed · `1` unexpected.

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
faucet       = false

[networks.testnet]
network_id   = "test"
indexer      = "https://indexer.testnet-02.midnight.network/api/v1/graphql"
indexer_ws   = "wss://indexer.testnet-02.midnight.network/api/v1/graphql/ws"
node         = "https://rpc.testnet-02.midnight.network"
node_ws      = "wss://rpc.testnet-02.midnight.network"
proof_server = "auto"
faucet       = true
faucet_url   = "https://faucet.testnet-02.midnight.network"

[networks.preprod]
network_id   = "preprod"
indexer      = "https://indexer.preprod.midnight.network/api/v3/graphql"
indexer_ws   = "wss://indexer.preprod.midnight.network/api/v3/graphql/ws"
node         = "https://rpc.preprod.midnight.network"
node_ws      = "wss://rpc.preprod.midnight.network"
proof_server = "auto"
faucet       = true

[networks.mainnet]
network_id   = "mainnet"
indexer      = "https://indexer.mainnet.midnight.network/api/v3/graphql"
indexer_ws   = "wss://indexer.mainnet.midnight.network/api/v3/graphql/ws"
node         = "https://rpc.mainnet.midnight.network"
node_ws      = "wss://rpc.mainnet.midnight.network"
proof_server = "auto"
faucet       = false

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
