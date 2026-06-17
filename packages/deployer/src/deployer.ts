import { shieldedToken, unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import type {
  EnvironmentConfiguration,
  MidnightWalletProvider,
} from '@midnight-ntwrk/testkit-js';
import {
  DustAddress,
  ShieldedAddress,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';
import type { FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';
import type { Logger } from 'pino';
import * as Rx from 'rxjs';
import { CompactConfig } from './config/compact-config.ts';
import type { ContractConfig, NetworkConfig } from './config/schema.ts';
import { type DeploymentRecord, Deployments } from './deployments.ts';
import {
  ConfigError,
  DeployTxFailedError,
  UnfundedWalletError,
} from './errors.ts';

/**
 * Default sync ceiling (10 min). Overrides testkit-js's hardcoded 90 s
 * `waitForFunds` timeout, which is too short for real networks.
 */
const DEFAULT_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Tolerated sync gap, in events, for the chain-tip gate.
 * `FacadeState.isSynced` requires every sub-wallet to be *strictly*
 * complete (gap 0). On a live network the global dust stream advances
 * continuously, so the dust wallet sits a few events behind the tip
 * indefinitely and strict `isSynced` never flips. The gate would then time
 * out on a wallet that is in fact fully usable. `isCompleteWithin(50)` is the
 * SDK default (and what the unshielded wallet uses internally): it treats
 * "within 50 events of tip" as synced, which a live wallet reaches and
 * holds. See OpenZeppelin/compact-tools#115.
 */
const SYNC_MAX_GAP = 50n;

import { ConstructorArgs } from './loaders/args.ts';
import { Artifact } from './loaders/artifact.ts';
import { InitialPrivateState } from './loaders/init-state.ts';
import { SigningKey } from './loaders/signing-key.ts';
import { buildProviders } from './providers/build.ts';
import { applyNetwork } from './providers/network.ts';
import { ProofServer } from './providers/proof-server.ts';
import { WalletHandler } from './wallet/handler.ts';
import { resolveSeed } from './wallet/seeds.ts';

/** Inputs to {@link Deployer.prepare}. */
export interface DeployerOptions {
  contract: string;
  network?: string;
  configPath?: string;
  seedFile?: string;
  proofServer?: string;
  argsOverride?: string;
  /**
   * Programmatic constructor args. Highest precedence — overrides
   * `argsOverride`, the TOML `args` field, and any file/module ref.
   * Either a positional array (`[a, b, c]`) or a named object
   * (`{ foo: a, bar: b }`); named objects are reordered to match the
   * artifact's constructor signature.
   */
  args?: readonly unknown[] | Record<string, unknown>;
  initPrivateStateOverride?: string;
  logger: Logger;
  promptPassphrase?: (path: string) => Promise<string>;
  /**
   * Inject a shared wallet so back-to-back deploys reuse one UTXO view.
   * When set, prepare skips seed resolution + lifecycle management.
   * The caller owns `start()`/`stop()`. Avoids `DustDoubleSpend` from
   * indexer lag between rapid deploys.
   */
  walletProvider?: MidnightWalletProvider;
  /**
   * Pass `inMemoryPrivateStateProvider()` in tests; otherwise multiple
   * deployers in one process hit fcntl LOCK contention on the default
   * LevelDB directory.
   */
  privateStateProvider?: PrivateStateProvider;
  /**
   * Sync ceiling (ms). Precedence: this value > `[networks.X].sync_timeout`
   * (seconds, from TOML) > {@link DEFAULT_SYNC_TIMEOUT_MS}. Ignored when
   * {@link walletProvider} is injected.
   */
  syncTimeoutMs?: number;
  /** Force a fresh sync from genesis. Default `false` (cache reuse saves the 30–60 min first-preprod sync). */
  skipWalletCache?: boolean;
  /**
   * Import a pre-warmed dust wallet state file into `.states/` before
   * the wallet builds. Use this to skip the first-run preprod cold
   * sync when you already have a `serializeState()` output from a
   * prior session. Argv: `--seed-cache-from-dust`.
   */
  seedCacheDust?: string;
  /** Like {@link seedCacheDust} but for the shielded sub-wallet. Argv: `--seed-cache-from-shielded`. */
  seedCacheShielded?: string;
  /**
   * Sync batch size for the shielded + dust sub-wallets. Precedence: this
   * value > `[networks.X].sync_batch_size` (TOML) > 5000. Raise it to replay
   * a long dust history faster (more memory per batch); lower it on a
   * memory-constrained host. Ignored when {@link walletProvider} is injected.
   * Argv: `--sync-batch-size`.
   */
  syncBatchSize?: number;
}

/** Result of {@link Deployer.deploy} / {@link Deployer.dryRun}. On-chain fields are empty when `dryRun: true`. */
export interface DeployResult {
  contractName: string;
  network: string;
  address: string;
  txHash: string;
  txId: string;
  blockHeight: number;
  signingKey: string;
  deployer: string;
  artifact: string;
  deploymentsFile: string;
  dryRun: boolean;
  /** `[networks.X].explorer` + `/contracts/0x<address>`, or empty when no explorer is configured / in dry-run. */
  explorerUrl: string;
}

interface PreparedState {
  opts: DeployerOptions;
  logger: Logger;
  config: CompactConfig;
  networkName: string;
  network: NetworkConfig;
  contract: ContractConfig;
  signingKey: SigningKey;
  artifact: Artifact;
  args: ConstructorArgs;
  initialPrivateState: InitialPrivateState | undefined;
  wallet: MidnightWalletProvider;
  deployer: string;
  env: EnvironmentConfiguration;
  resources: AsyncDisposableStack;
}

/**
 * Stateful handle for one contract's deploy lifecycle. Always acquire
 * with `await using`: `[Symbol.asyncDispose]` releases the proof-server
 * container (if `"auto"`) and the wallet (if built here, not injected).
 */
export class Deployer implements AsyncDisposable {
  /** Contract name as specified in opts. */
  readonly contractName: string;
  /** Resolved network name (`opts.network` or `[profile].default_network`). */
  readonly networkName: string;
  /** Hex of the deployer's coin public key. */
  readonly deployer: string;
  /** Loaded artifact: zk config path + compiled-contract handle. */
  readonly artifact: Artifact;
  /** Per-contract signing key loaded from disk. */
  readonly signingKey: SigningKey;

  readonly #state: PreparedState;

  private constructor(state: PreparedState) {
    this.#state = state;
    this.contractName = state.opts.contract;
    this.networkName = state.networkName;
    this.deployer = state.deployer;
    this.artifact = state.artifact;
    this.signingKey = state.signingKey;
  }

  /**
   * Load config + artifact + signing key, start proof server, build or
   * adopt a wallet. Throws typed errors that map to CLI exit codes via
   * {@link DeployError.exitCode}.
   */
  static async prepare(opts: DeployerOptions): Promise<Deployer> {
    const { logger } = opts;

    const config = await CompactConfig.load(opts.configPath);
    const { rootDir } = config;
    const { networkName, network, contract } = resolveTargets(opts, config);
    const signingKey = await SigningKey.load(
      rootDir,
      contract.signing_key_file,
    );

    const seedResolution = opts.walletProvider
      ? undefined
      : await resolveSeed({
          config,
          networkName,
          network,
          seedFile: opts.seedFile,
          promptPassphrase: opts.promptPassphrase,
        });
    if (seedResolution) {
      logger.debug(`Resolved deployer seed from: ${seedResolution.origin}`);
    }

    // Stack owns every resource acquired below. On any throw before
    // the final `stack.move()`, `await using` disposes them in reverse
    // order; on success, ownership transfers to the returned Deployer
    // and the local `await using` becomes a no-op.
    await using stack = new AsyncDisposableStack();

    const proofServer = await ProofServer.start({
      cliOverride: opts.proofServer,
      network,
      logger,
    });
    stack.use(proofServer);

    const { env } = applyNetwork(network, proofServer.url);
    logger.debug(
      `Network ID: ${env.networkId}; proof server: ${env.proofServer}`,
    );

    const artifact = await Artifact.load({
      rootDir,
      artifactsDir: config.artifactsDir,
      artifact: contract.artifact,
      contractName: opts.contract,
      witnesses: contract.witnesses,
    });
    logger.debug(
      `Artifact: ${artifact.artifactPath} (${artifact.circuitNames.length} circuits)`,
    );

    let wallet: MidnightWalletProvider;
    if (opts.walletProvider) {
      wallet = opts.walletProvider;
    } else {
      if (!seedResolution) {
        throw new Error('internal: seedResolution missing for owned wallet');
      }
      // Sync tuning precedence: CLI/programmatic option > [networks.X] TOML
      // value > built-in default. `sync_batch_size` falls through to
      // WalletHandler's 5000 default when neither is set.
      const syncBatchSize = opts.syncBatchSize ?? network.sync_batch_size;
      const syncTimeoutMs =
        opts.syncTimeoutMs ??
        (network.sync_timeout !== undefined
          ? network.sync_timeout * 1000
          : DEFAULT_SYNC_TIMEOUT_MS);
      const owned = await WalletHandler.build(
        logger,
        env,
        seedResolution.seed,
        {
          skipWalletCache: opts.skipWalletCache,
          seedCacheDust: opts.seedCacheDust,
          seedCacheShielded: opts.seedCacheShielded,
          syncBatchSize,
        },
      );
      stack.use(owned);
      wallet = owned.provider;
      // Kick off the wallet's internal indexer subscription without
      // blocking on testkit-js's 90 s `waitForFunds` gate (which is too
      // short for real networks). Then drive sync ourselves with a
      // configurable ceiling and surface a clear `UnfundedWalletError`
      // if we reach chain tip and still have no shielded balance.
      await wallet.start(false);
      // Surface the wallet's derived bech32m addresses right away so
      // the user can sanity-check they match the seed they intended
      // *before* settling in for a long shielded sync.
      await logWalletAddresses(wallet, logger);
      await syncAndVerifyFunds({
        wallet,
        timeoutMs: syncTimeoutMs,
        logger,
        // Periodic checkpoint: every 5 min during sync, snapshot both
        // sub-wallet caches. If the user interrupts a long first-run,
        // the next attempt resumes from the most recent checkpoint.
        onCheckpoint: () => owned.saveCache(),
      });
      // Snapshot the shielded + dust sub-wallets now that sync is
      // complete. Best-effort: failures are warn-logged in
      // `saveCache`'s caller; never block the deploy on a cache write.
      try {
        await owned.saveCache();
      } catch (e) {
        logger.warn(
          { err: (e as Error).message },
          'Wallet cache save failed; next run will re-sync',
        );
      }
    }

    const args = await ConstructorArgs.load(
      contract,
      rootDir,
      opts.argsOverride,
      opts.args,
      artifact.artifactPath,
    );
    const initialPrivateState = await InitialPrivateState.load(
      contract.init_private_state,
      rootDir,
    );
    const deployer = wallet.getCoinPublicKey();

    return new Deployer({
      opts,
      logger,
      config,
      networkName,
      network,
      contract,
      signingKey,
      artifact,
      args,
      initialPrivateState,
      wallet,
      deployer,
      env,
      resources: stack.move(),
    });
  }

  /** Submit the deploy tx, persist the record under `deployments/<network>.json`, return the result. */
  async deploy(): Promise<DeployResult> {
    const s = this.#state;
    const providers = buildProviders({
      env: s.env,
      wallet: s.wallet,
      contractName: s.opts.contract,
      contract: s.contract,
      zkConfigPath: s.artifact.zkConfigPath,
      privateStateProvider: s.opts.privateStateProvider,
    });
    const txResult = await executeDeploy({
      providers,
      contractName: s.opts.contract,
      contract: s.contract,
      artifact: s.artifact,
      signingKey: s.signingKey.hex,
      args: s.args.values,
      initialPrivateState: s.initialPrivateState?.value,
    });

    const record = toDeploymentRecord({
      deployTxData: txResult.deployTxData,
      signingKey: s.signingKey.hex,
      deployer: s.deployer,
      artifact: s.contract.artifact,
    });

    const deployments = new Deployments({
      rootDir: s.config.rootDir,
      deploymentsDir: s.config.deploymentsDir,
      network: s.networkName,
    });
    const persisted = await deployments.record(s.opts.contract, record);

    return {
      contractName: s.opts.contract,
      network: s.networkName,
      address: record.address,
      txHash: record.txHash,
      txId: record.txId,
      blockHeight: record.blockHeight,
      signingKey: record.signingKey,
      deployer: record.deployer,
      artifact: record.artifact,
      deploymentsFile: persisted.head,
      dryRun: false,
      explorerUrl: buildExplorerUrl(s.network.explorer, record.address),
    };
  }

  /** Log a "would deploy" event and return a synthetic result. No tx, no file. */
  async dryRun(): Promise<DeployResult> {
    const s = this.#state;
    s.logger.info(
      {
        contract: s.opts.contract,
        network: s.networkName,
        artifact: s.artifact.artifactPath,
        argCount: s.args.length,
        hasPrivateState: s.initialPrivateState !== undefined,
        deployer: s.deployer,
      },
      'dry-run: would deploy',
    );
    return {
      contractName: s.opts.contract,
      network: s.networkName,
      address: '',
      txHash: '',
      txId: '',
      blockHeight: 0,
      signingKey: s.signingKey.hex,
      deployer: s.deployer,
      artifact: s.contract.artifact,
      deploymentsFile: '',
      dryRun: true,
      explorerUrl: '',
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#state.resources.disposeAsync();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedTargets {
  networkName: string;
  network: NetworkConfig;
  contract: ContractConfig;
}

function resolveTargets(
  opts: DeployerOptions,
  config: CompactConfig,
): ResolvedTargets {
  const networkName = opts.network ?? config.defaultNetwork;
  if (!networkName) {
    throw new ConfigError(
      'No network selected. Pass --network <name> or set [profile].default_network.',
    );
  }
  return {
    networkName,
    network: config.network(networkName),
    contract: config.contract(opts.contract),
  };
}

/**
 * Print the wallet's three bech32m addresses so the user can verify
 * the seed before a long sync. Best-effort: warn-and-continue on
 * failure.
 */
async function logWalletAddresses(
  wallet: MidnightWalletProvider,
  logger: Logger,
): Promise<void> {
  try {
    const networkId = getNetworkId();
    const [shieldedState, unshieldedState, dustState] = await Promise.all([
      Rx.firstValueFrom(wallet.wallet.shielded.state),
      Rx.firstValueFrom(wallet.wallet.unshielded.state),
      Rx.firstValueFrom(wallet.wallet.dust.state),
    ]);
    const shielded = ShieldedAddress.codec
      .encode(networkId, shieldedState.address)
      .toString();
    const unshielded = UnshieldedAddress.codec
      .encode(networkId, unshieldedState.address)
      .toString();
    const dust = DustAddress.codec
      .encode(networkId, dustState.address)
      .toString();
    logger.info('Wallet addresses (verify these match your seed):');
    logger.info(`  shielded:   ${shielded}`);
    logger.info(`  unshielded: ${unshielded}`);
    logger.info(`  dust:       ${dust}`);
  } catch (e) {
    logger.warn(
      { err: (e as Error).message },
      'Could not derive wallet addresses for display; continuing',
    );
  }
}

/**
 * One-liner progress string for "Still syncing". Accepts both progress
 * shapes (shielded/dust use `appliedIndex`/`highestIndex`; unshielded
 * uses `appliedId`/`highestTransactionId`).
 */
function describeProgress(p: { isStrictlyComplete: () => boolean }): string {
  const complete = p.isStrictlyComplete();
  const fields = p as unknown as {
    appliedIndex?: bigint;
    highestIndex?: bigint;
    highestRelevantIndex?: bigint;
    appliedId?: bigint;
    highestTransactionId?: bigint;
    isConnected?: boolean;
  };
  const applied = fields.appliedIndex ?? fields.appliedId ?? 0n;
  const highest = fields.highestIndex ?? fields.highestTransactionId ?? 0n;
  const connected = fields.isConnected ?? false;
  // Once the indexer has told the wallet its max event id, we can
  // render a real progress percentage. Until then surface "applied,
  // highest unknown" and the subscription's connection state so the
  // user can tell "still connecting" from "connected but no events yet"
  // from "events flowing".
  if (highest === 0n) {
    return `applied=${applied} highest=? connected=${connected} complete=${complete}`;
  }
  const pct = Number((applied * 100n) / highest);
  return `${applied}/${highest} (${pct}%) connected=${connected} complete=${complete}`;
}

/**
 * Drive the wallet to chain tip and assert spendable funds. Gates on each
 * sub-wallet being within {@link SYNC_MAX_GAP} events of the tip rather
 * than strictly complete: on a live network the global dust stream never
 * settles to gap 0, so strict `FacadeState.isSynced` never fires and the
 * gate times out on a perfectly usable wallet (#115). The gate still waits
 * on all three sub-wallets; dropping the dust/shielded wait entirely
 * regressed on local with `Invalid Transaction (custom error 170)`.
 * Throttles progress logs to once per 30 s. Throws
 * {@link UnfundedWalletError} on empty wallet.
 */
async function syncAndVerifyFunds(args: {
  wallet: MidnightWalletProvider;
  timeoutMs: number;
  logger: Logger;
  /** Periodic checkpoint so a Ctrl+C mid-sync survives. Owned-wallet branch only. */
  onCheckpoint?: () => Promise<void>;
}): Promise<void> {
  const { wallet, timeoutMs, logger, onCheckpoint } = args;
  logger.info(
    `Syncing wallet to chain tip (timeout ${Math.round(timeoutMs / 1000)}s)…`,
  );
  const start = Date.now();

  // Two subscriptions to the same observable: one logs throttled
  // progress lines for UX, the other waits for completion. The progress
  // tap deliberately runs through `Rx.throttleTime(30_000)` so the
  // shielded-sync flood doesn't drown the terminal; the completion gate
  // doesn't throttle, so the deploy proceeds the instant sync flips.
  const state$ = wallet.wallet.state();
  const progressSub = state$
    .pipe(
      Rx.throttleTime(30_000, undefined, { leading: false, trailing: true }),
    )
    .subscribe((s) => {
      const elapsedSec = Math.round((Date.now() - start) / 1000);
      const elapsedHms =
        elapsedSec < 60
          ? `${elapsedSec}s`
          : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
      // Pull running balance projections each tick so the user can
      // see funds materialise mid-sync (NIGHT becomes visible the
      // moment unshielded completes; dust accumulates as the wallet
      // processes events even before its sync is strictly complete).
      const shieldedBal = s.shielded.balances[shieldedToken().raw] ?? 0n;
      const unshieldedBal = s.unshielded.balances[unshieldedToken().raw] ?? 0n;
      const dustBal = s.dust.balance(new Date());
      logger.info(
        `Still syncing (${elapsedHms} elapsed). ` +
          `shielded ${describeProgress(s.shielded.state.progress)} balance=${shieldedBal}; ` +
          `unshielded ${describeProgress(s.unshielded.progress)} balance=${unshieldedBal}; ` +
          `dust ${describeProgress(s.dust.state.progress)} balance=${dustBal}`,
      );
    });

  // Periodic checkpoint: snapshot the wallet caches every 5 min so a
  // user who Ctrl+C's a long preprod first-run can resume from the
  // latest snapshot instead of starting at id=0 again. Best-effort:
  // a failed save logs a warning and the sync keeps going. Skipped
  // when `onCheckpoint` is not provided (i.e. injected-wallet callers
  // where the deployer doesn't own persistence).
  let checkpointInFlight = false;
  const checkpointSub = onCheckpoint
    ? state$
        .pipe(
          Rx.throttleTime(5 * 60 * 1000, undefined, {
            leading: false,
            trailing: true,
          }),
        )
        .subscribe(() => {
          if (checkpointInFlight) return;
          checkpointInFlight = true;
          onCheckpoint().finally(() => {
            checkpointInFlight = false;
          });
        })
    : undefined;

  // Per-sub-wallet edge-trigger: the first time each sub-wallet flips
  // to `complete=true`, log its current balance immediately. This lets
  // a user with NIGHT+dust (the typical preprod-faucet wallet shape)
  // see their unshielded balance after ~30 s instead of waiting for
  // the full shielded sync (30 – 60 min) to surface anything.
  const seenComplete = { shielded: false, unshielded: false, dust: false };
  const balanceSub = state$.subscribe((s) => {
    if (
      !seenComplete.unshielded &&
      s.unshielded.progress.isStrictlyComplete()
    ) {
      seenComplete.unshielded = true;
      const bal = s.unshielded.balances[unshieldedToken().raw] ?? 0n;
      logger.info(`Unshielded sync complete — NIGHT balance: ${bal}`);
    }
    if (!seenComplete.dust && s.dust.state.progress.isStrictlyComplete()) {
      seenComplete.dust = true;
      const bal = s.dust.balance(new Date());
      logger.info(`Dust sync complete — dust balance: ${bal}`);
    }
    if (
      !seenComplete.shielded &&
      s.shielded.state.progress.isStrictlyComplete()
    ) {
      seenComplete.shielded = true;
      const bal = s.shielded.balances[shieldedToken().raw] ?? 0n;
      logger.info(`Shielded sync complete — shielded balance: ${bal}`);
    }
  });

  let synced: FacadeState;
  try {
    synced = await Rx.firstValueFrom(
      state$.pipe(
        // Tolerant tip gate: all three sub-wallets within SYNC_MAX_GAP
        // events of the tip. Strict `s.isSynced` never fires on a live
        // chain because the global dust stream keeps advancing (#115).
        Rx.filter(
          (s: FacadeState) =>
            s.shielded.state.progress.isCompleteWithin(SYNC_MAX_GAP) &&
            s.dust.state.progress.isCompleteWithin(SYNC_MAX_GAP) &&
            s.unshielded.progress.isCompleteWithin(SYNC_MAX_GAP),
        ),
        Rx.timeout({
          each: timeoutMs,
          with: () =>
            Rx.throwError(
              () => new Error(`Wallet sync timeout after ${timeoutMs}ms`),
            ),
        }),
      ),
    );
  } finally {
    progressSub.unsubscribe();
    balanceSub.unsubscribe();
    checkpointSub?.unsubscribe();
  }

  const totalSec = Math.round((Date.now() - start) / 1000);
  const totalHms =
    totalSec < 60
      ? `${totalSec}s`
      : `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
  logger.info(`Sync complete after ${totalHms}`);

  // Accept funds in either shielded or unshielded. Preprod faucets
  // hand out unshielded NIGHT, while a freshly bridged wallet may sit
  // entirely in the shielded layer. Both are deployable: dust for
  // fees auto-generates from either NIGHT or shielded holdings.
  // Mirrors midnight-apps's `waitForUnshieldedFunds` semantics.
  const shieldedBal = synced.shielded.balances[shieldedToken().raw];
  const unshieldedBal = synced.unshielded.balances[unshieldedToken().raw];
  const hasShielded = shieldedBal !== undefined && shieldedBal > 0n;
  const hasUnshielded = unshieldedBal !== undefined && unshieldedBal > 0n;
  if (!hasShielded && !hasUnshielded) {
    throw new UnfundedWalletError(wallet.getCoinPublicKey());
  }
  logger.info(
    `Wallet balance: shielded=${shieldedBal ?? 0n}, unshielded=${unshieldedBal ?? 0n}`,
  );
}

interface ExecuteDeployArgs {
  providers: Parameters<typeof deployContract>[0];
  contractName: string;
  contract: ContractConfig;
  artifact: Artifact;
  signingKey: string;
  args: readonly unknown[];
  initialPrivateState: unknown;
}

/** Submit the deploy tx; wrap failures in {@link DeployTxFailedError}. */
async function executeDeploy({
  providers,
  contractName,
  contract,
  artifact,
  signingKey,
  args,
  initialPrivateState,
}: ExecuteDeployArgs): Promise<Awaited<ReturnType<typeof deployContract>>> {
  const compiled = artifact.compiledContract as Parameters<
    typeof deployContract
  >[1]['compiledContract'];
  const base = {
    compiledContract: compiled,
    signingKey,
    args,
  } as Parameters<typeof deployContract>[1];
  const deployOptions =
    contract.private_state_id !== undefined
      ? {
          ...base,
          privateStateId: contract.private_state_id,
          initialPrivateState,
        }
      : base;

  try {
    return await deployContract(providers, deployOptions);
  } catch (e) {
    throw new DeployTxFailedError(
      `Deploy of "${contractName}" failed: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

type ContractDeployResult = Awaited<ReturnType<typeof deployContract>>;

/** Build `<explorer>/contracts/0x<address>`, or `''` when no explorer / no address. */
function buildExplorerUrl(base: string | undefined, address: string): string {
  if (!base || !address) return '';
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  const hex = address.startsWith('0x') ? address : `0x${address}`;
  return `${trimmed}/contracts/${hex}`;
}

function toDeploymentRecord({
  deployTxData,
  signingKey,
  deployer,
  artifact,
}: {
  deployTxData: ContractDeployResult['deployTxData'];
  signingKey: string;
  deployer: string;
  artifact: string;
}): DeploymentRecord {
  return {
    address: deployTxData.public.contractAddress,
    txHash: deployTxData.public.txHash,
    txId: deployTxData.public.txId,
    blockHeight: deployTxData.public.blockHeight,
    signingKey,
    deployer,
    artifact,
    timestamp: new Date().toISOString(),
  };
}
