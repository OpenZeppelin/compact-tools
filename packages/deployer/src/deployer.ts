import { createHash } from 'node:crypto';
import type { PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import type {
  EnvironmentConfiguration,
  MidnightWalletProvider,
} from '@midnight-ntwrk/testkit-js';
import type { Logger } from 'pino';
import { CompactConfig } from './config/compact-config.ts';
import type { ContractConfig, NetworkConfig } from './config/schema.ts';
import type { DeploymentRecord, DeploymentsPaths } from './deployments.ts';
import { Deployments } from './deployments.ts';
import {
  ConfigError,
  DeploymentsFileError,
  PendingDeployExistsError,
} from './errors.ts';
import { ConstructorArgs } from './loaders/args.ts';
import { Artifact } from './loaders/artifact.ts';
import { InitialPrivateState } from './loaders/init-state.ts';
import { SigningKey } from './loaders/signing-key.ts';
import { buildProviders } from './providers/build.ts';
import { applyNetwork } from './providers/network.ts';
import { ProofServer } from './providers/proof-server.ts';
import {
  awaitDeployFinalization,
  buildExplorerUrl,
  DEFAULT_TX_TIMEOUT_MS,
  persistDeployPrivateState,
  submitDeploy,
  toConfirmedRecord,
  toPendingRecord,
} from './services/deploy-tx.ts';
import { formatError } from './services/error-format.ts';
import {
  DEFAULT_SYNC_TIMEOUT_MS,
  logWalletAddresses,
  syncAndVerifyFunds,
} from './services/wallet-sync.ts';
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
  /** Like {@link seedCacheDust} but for the unshielded sub-wallet. Argv: `--seed-cache-from-unshielded`. */
  seedCacheUnshielded?: string;
  /**
   * Sync batch size for the shielded + dust sub-wallets. Precedence: this
   * value > `[networks.X].sync_batch_size` (TOML) > 5000. Raise it to replay
   * a long dust history faster (more memory per batch); lower it on a
   * memory-constrained host. Ignored when {@link walletProvider} is injected.
   * Argv: `--sync-batch-size`.
   */
  syncBatchSize?: number;
  /**
   * Ceiling on the wait for deploy-tx finalization. Default
   * {@link DEFAULT_TX_TIMEOUT_MS}. On timeout the pending ledger record
   * survives so the tx can be reconciled by hand. Argv: `--tx-timeout`
   * (seconds).
   */
  txTimeoutMs?: number;
  /**
   * Replace a pending ledger record for this contract instead of refusing to
   * deploy over it. Argv: `--force`.
   */
  force?: boolean;
}

/** Result of {@link Deployer.deploy} / {@link Deployer.dryRun}. On-chain fields are empty when `dryRun: true`. */
export interface DeployResult {
  contractName: string;
  network: string;
  address: string;
  txHash: string;
  txId: string;
  blockHeight: number;
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
  /**
   * SHA-256 of the resolved seed: the secret material the default LevelDB
   * private-state password derives from. `undefined` when the wallet was
   * injected, in which case the caller must supply `privateStateProvider`.
   */
  privateStateSecret: string | undefined;
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

    // One discriminated value instead of two parallel ones: every later
    // use of the seed is reachable only through the `owned` arm, so the
    // "injected wallet has no seed" invariant is checked by the compiler
    // rather than re-asserted at runtime.
    const walletSource = opts.walletProvider
      ? ({ kind: 'injected', provider: opts.walletProvider } as const)
      : ({
          kind: 'owned',
          resolution: await resolveSeed({
            config,
            networkName,
            network,
            seedFile: opts.seedFile,
            promptPassphrase: opts.promptPassphrase,
          }),
        } as const);
    if (walletSource.kind === 'owned') {
      logger.debug(
        `Resolved deployer seed from: ${walletSource.resolution.origin}`,
      );
    }
    // Hashed here because `prepare` is the only scope holding the seed, and
    // the private-state password must derive from secret material.
    const privateStateSecret =
      walletSource.kind === 'owned'
        ? createHash('sha256')
            .update(walletSource.resolution.seed.value)
            .digest('hex')
        : undefined;

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

    // Loaded before the wallet block: both depend only on the config and the
    // artifact, and a bad args source or init-state ref must fail now rather
    // than after a 30-60 min first sync.
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

    let wallet: MidnightWalletProvider;
    if (walletSource.kind === 'injected') {
      wallet = walletSource.provider;
    } else {
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
        walletSource.resolution.seed,
        {
          rootDir,
          skipWalletCache: opts.skipWalletCache,
          seedCacheDust: opts.seedCacheDust,
          seedCacheShielded: opts.seedCacheShielded,
          seedCacheUnshielded: opts.seedCacheUnshielded,
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
          { err: formatError(e) },
          'Wallet cache save failed; next run will re-sync',
        );
      }
    }

    const deployer = wallet.getCoinPublicKey();

    return new Deployer({
      opts,
      logger,
      config,
      networkName,
      network,
      contract,
      signingKey,
      privateStateSecret,
      artifact,
      args,
      initialPrivateState,
      wallet,
      deployer,
      env,
      resources: stack.move(),
    });
  }

  /**
   * Submit the deploy tx, persist a pending record, wait for finalization,
   * then promote the record to confirmed under `deployments/<network>.json`.
   *
   * The pending record is what makes the deploy recoverable: every failure
   * after submission leaves the address and txId on disk and names them in
   * the thrown error.
   */
  async deploy(): Promise<DeployResult> {
    const s = this.#state;
    const contractName = s.opts.contract;
    const deployments = new Deployments({
      rootDir: s.config.rootDir,
      deploymentsDir: s.config.deploymentsDir,
      network: s.networkName,
    });
    const force = s.opts.force === true;
    // Checked before proving: submitting a tx we would then refuse to record
    // costs the user fees for nothing.
    await deployments.assertRecordable(contractName, { force });

    const providers = buildProviders({
      env: s.env,
      wallet: s.wallet,
      contractName,
      contract: s.contract,
      zkConfigPath: s.artifact.zkConfigPath,
      rootDir: s.config.rootDir,
      privateStateProvider: s.opts.privateStateProvider,
      privateStateSecret: s.privateStateSecret,
    });
    const submitted = await submitDeploy({
      providers,
      contractName,
      contract: s.contract,
      artifact: s.artifact,
      signingKey: s.signingKey.hex,
      args: s.args.values,
      initialPrivateState: s.initialPrivateState?.value,
    });

    const pending = toPendingRecord({
      submitted,
      deployer: s.deployer,
      artifact: s.contract.artifact,
    });
    await this.#persist(pending, () =>
      deployments.record(contractName, pending, { force }),
    );

    const finalized = await awaitDeployFinalization({
      providers,
      contractName,
      submitted,
      txTimeoutMs: s.opts.txTimeoutMs ?? DEFAULT_TX_TIMEOUT_MS,
    });
    // Order copied from midnight-js's own post-success path, and reached only
    // on `SucceedEntirely`.
    await persistDeployPrivateState({
      providers,
      contract: s.contract,
      submitted,
    });

    const record = toConfirmedRecord({ pending, finalized });
    const persisted = await this.#persist(record, () =>
      deployments.confirm(contractName, record),
    );

    return {
      contractName,
      network: s.networkName,
      address: record.address,
      txHash: record.txHash,
      txId: record.txId,
      blockHeight: record.blockHeight,
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
      deployer: s.deployer,
      artifact: s.contract.artifact,
      deploymentsFile: '',
      dryRun: true,
      explorerUrl: '',
    };
  }

  /**
   * Log `record` at info, then write it. A ledger write can fail on a lock
   * timeout, a permission error, or a corrupt `<network>.json`, none of which
   * undo the tx, so the log line and the rethrown message both carry the
   * on-chain identifiers.
   */
  async #persist(
    record: DeploymentRecord,
    write: () => Promise<DeploymentsPaths>,
  ): Promise<DeploymentsPaths> {
    this.#state.logger.info(record, `Deploy record (${record.status})`);
    try {
      return await write();
    } catch (e) {
      if (e instanceof PendingDeployExistsError) throw e;
      throw new DeploymentsFileError(
        `Deploy of "${this.contractName}" was submitted but the deployments ledger write failed: ${formatError(e)}. Record it by hand: ${identifiers(record)}.`,
        { cause: e },
      );
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#state.resources.disposeAsync();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function identifiers(record: DeploymentRecord): string {
  const base = `address ${record.address}, txId ${record.txId}`;
  return record.status === 'confirmed'
    ? `${base}, txHash ${record.txHash}`
    : base;
}

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
