import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  type EnvironmentConfiguration,
  FaucetClient,
  type MidnightWalletProvider,
} from '@midnight-ntwrk/testkit-js';
import { UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import type { Logger } from 'pino';
import * as Rx from 'rxjs';
import { CompactConfig } from './config/compact-config.ts';
import type { ContractConfig, NetworkConfig } from './config/schema.ts';
import { Deployments, type DeploymentRecord } from './deployments.ts';
import { ConfigError, DeployTxFailedError } from './errors.ts';
import { ConstructorArgs } from './loaders/args.ts';
import { Artifact } from './loaders/artifact.ts';
import { InitialPrivateState } from './loaders/init-state.ts';
import { SigningKey } from './loaders/signing-key.ts';
import { buildProviders } from './providers/build.ts';
import { applyNetwork } from './providers/network.ts';
import { ProofServer } from './providers/proof-server.ts';
import { WalletHandler } from './wallet/handler.ts';
import { type SeedResolution, resolveSeed } from './wallet/seeds.ts';

/**
 * Inputs to {@link Deployer.prepare}. The CLI in `bin/compact-deploy.ts`
 * is a thin shell that fills these out from argv + env; embedders can
 * construct them directly to skip TOML lookup or to inject a shared
 * wallet.
 */
export interface DeployerOptions {
  contract: string;
  network?: string;
  configPath?: string;
  seedFile?: string;
  proofServer?: string;
  skipFaucet?: boolean;
  argsOverride?: string;
  initPrivateStateOverride?: string;
  logger: Logger;
  promptPassphrase?: (path: string) => Promise<string>;
  /**
   * Inject an already-built, already-started `MidnightWalletProvider`.
   * When set, {@link Deployer.prepare} skips seed resolution, wallet
   * build, faucet calls, `wallet.start()`, and `wallet.stop()` — the
   * caller owns the wallet's lifecycle.
   *
   * Use this when running many deploys in a single Node process (e.g.
   * integration test suites). Each `WalletHandler.build` rebuilds a
   * wallet that syncs from the indexer; under rapid back-to-back
   * deploys the indexer can lag and the new wallet sees an
   * already-spent dust UTXO, producing a `DustDoubleSpend` rejection.
   * Sharing one wallet across deploys keeps its UTXO view internally
   * consistent.
   */
  walletProvider?: MidnightWalletProvider;
}

/**
 * Final shape returned by {@link Deployer.deploy} and
 * {@link Deployer.dryRun}. In dry-run mode the on-chain fields
 * (`address`, `txHash`, `txId`, `blockHeight`, `deploymentsFile`) are
 * empty and `dryRun: true`.
 */
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
}

/**
 * Internal bundle that {@link Deployer.prepare} produces and the
 * action methods consume. Keeping the action methods pure transforms
 * over this struct makes the deploy/dry-run paths read top-to-bottom.
 */
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
  faucetUrl: string | undefined;
  resources: AsyncDisposableStack;
}

/**
 * Stateful handle for a single contract's deploy lifecycle.
 *
 * `Deployer.prepare(opts)` loads config + artifact + signing key,
 * starts the proof server, builds or adopts a wallet (started, optional
 * faucet), and returns an instance ready to {@link deploy} or
 * {@link dryRun}.
 *
 * Always acquired with `await using` — `[Symbol.asyncDispose]` stops
 * the wallet (only if built here) and the proof-server container
 * (only if `"auto"`).
 *
 * Resource handling: {@link prepare} accumulates owned resources into
 * a local {@link AsyncDisposableStack}. On failure mid-prepare,
 * `await using` disposes everything it acquired so far; on success,
 * ownership transfers to the returned instance via `stack.move()` and
 * `[Symbol.asyncDispose]` disposes it later.
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
   * Load + validate everything needed to deploy, in order:
   *
   *  1. Parse `compact.toml`, pick network + contract.
   *  2. Load signing key from `contract.signing_key_file`.
   *  3. Resolve seed (unless `opts.walletProvider` was injected).
   *  4. Start the proof server (CLI > TOML URL > `"auto"` > env > default).
   *  5. Load the artifact (compiled contract, zk config).
   *  6. Build the wallet (or adopt the injected one), faucet + start
   *     when owned.
   *  7. Load constructor args and initial private state.
   *
   * Throws typed errors ({@link ConfigError}, {@link WalletError}, etc.)
   * that map to the CLI's exit codes via `DeployError.exitCode`.
   */
  static async prepare(opts: DeployerOptions): Promise<Deployer> {
    const { logger } = opts;

    const config = await CompactConfig.load(opts.configPath);
    const { rootDir } = config;
    const { networkName, network, contract } = resolveTargets(opts, config);
    const signingKey = await SigningKey.load(rootDir, contract.signing_key_file);

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

    const { env, faucetUrl } = applyNetwork(network, proofServer.url);
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
      const owned = await WalletHandler.build(logger, env, seedResolution.seed);
      stack.use(owned);
      wallet = owned.provider;
      await maybeRequestFaucet(opts, wallet, env, network, logger);
      await wallet.start(true);
    }

    const args = await ConstructorArgs.load(
      contract,
      rootDir,
      opts.argsOverride,
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
      faucetUrl,
      resources: stack.move(),
    });
  }

  /**
   * Submit the deploy transaction, persist the deployment record under
   * `deployments/<network>.json` (rotating any prior head into history),
   * and return the success result.
   */
  async deploy(): Promise<DeployResult> {
    const s = this.#state;
    const providers = buildProviders({
      env: s.env,
      wallet: s.wallet,
      contractName: s.opts.contract,
      contract: s.contract,
      zkConfigPath: s.artifact.zkConfigPath,
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

    return successResult({
      contractName: s.opts.contract,
      networkName: s.networkName,
      record,
      deploymentsFile: persisted.head,
    });
  }

  /**
   * Log a structured "would deploy" event and return a synthetic
   * result. No transaction is submitted and no file is written.
   */
  async dryRun(): Promise<DeployResult> {
    const s = this.#state;
    logDryRun(s.logger, {
      contractName: s.opts.contract,
      networkName: s.networkName,
      artifact: s.artifact,
      argCount: s.args.length,
      hasPrivateState: s.initialPrivateState !== undefined,
      faucet: !!s.network.faucet && !s.opts.skipFaucet,
      faucetUrl: s.faucetUrl,
      deployer: s.deployer,
    });
    return dryRunResult({
      contractName: s.opts.contract,
      networkName: s.networkName,
      signingKey: s.signingKey.hex,
      deployer: s.deployer,
      artifact: s.contract.artifact,
    });
  }

  /**
   * Release every resource `prepare` acquired: proof-server container
   * (if `"auto"`) and the wallet (if built here, not injected).
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.#state.resources.disposeAsync();
  }
}

// ---------------------------------------------------------------------------
// Helpers — pure transforms used by `prepare` and the action methods.
// ---------------------------------------------------------------------------

interface ResolvedTargets {
  networkName: string;
  network: NetworkConfig;
  contract: ContractConfig;
}

/**
 * Pick the network and contract from `compact.toml`, defaulting the
 * network to `[profile].default_network` when `opts.network` isn't
 * passed. Throws {@link ConfigError} with the available set on each
 * invalid lookup.
 */
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
 * Hit the network's faucet for the deployer address when configured
 * (`[networks.X].faucet = true`, not `--skip-faucet`, and the resolved
 * `env.faucet` URL is present). Safe to call before `wallet.start()` —
 * we read the unshielded address from the wallet's already-running
 * state stream.
 */
async function maybeRequestFaucet(
  opts: DeployerOptions,
  wallet: MidnightWalletProvider,
  env: EnvironmentConfiguration,
  network: NetworkConfig,
  logger: Logger,
): Promise<void> {
  if (!network.faucet || opts.skipFaucet || !env.faucet) return;
  const initialUnshielded = await Rx.firstValueFrom(
    wallet.wallet.unshielded.state,
  );
  const address = UnshieldedAddress.codec
    .encode(getNetworkId(), initialUnshielded.address)
    .toString();
  logger.info(`Requesting faucet tokens for ${address}…`);
  await new FaucetClient(env.faucet, logger).requestTokens(address);
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

/**
 * Assemble the `deployContract` options (conditionally including the
 * private-state pair) and submit. Wraps any failure in
 * {@link DeployTxFailedError} so callers can branch on its `exitCode`
 * without parsing midnight-js error shapes.
 */
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

/** Map the midnight-js deploy-tx result into the persisted record shape. */
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

/** Emit the same structured `dry-run: would deploy` event the pipeline did. */
function logDryRun(
  logger: Logger,
  details: {
    contractName: string;
    networkName: string;
    artifact: Artifact;
    argCount: number;
    hasPrivateState: boolean;
    faucet: boolean;
    faucetUrl: string | undefined;
    deployer: string;
  },
): void {
  logger.info(
    {
      contract: details.contractName,
      network: details.networkName,
      artifact: details.artifact.artifactPath,
      argCount: details.argCount,
      hasPrivateState: details.hasPrivateState,
      faucet: details.faucet,
      faucetUrl: details.faucetUrl,
      deployer: details.deployer,
    },
    'dry-run: would deploy',
  );
}

/** Build the `DeployResult` returned from a dry run (no on-chain fields). */
function dryRunResult(params: {
  contractName: string;
  networkName: string;
  signingKey: string;
  deployer: string;
  artifact: string;
}): DeployResult {
  return {
    contractName: params.contractName,
    network: params.networkName,
    address: '',
    txHash: '',
    txId: '',
    blockHeight: 0,
    signingKey: params.signingKey,
    deployer: params.deployer,
    artifact: params.artifact,
    deploymentsFile: '',
    dryRun: true,
  };
}

/** Build the `DeployResult` returned from a confirmed deploy. */
function successResult(params: {
  contractName: string;
  networkName: string;
  record: DeploymentRecord;
  deploymentsFile: string;
}): DeployResult {
  return {
    contractName: params.contractName,
    network: params.networkName,
    address: params.record.address,
    txHash: params.record.txHash,
    txId: params.record.txId,
    blockHeight: params.record.blockHeight,
    signingKey: params.record.signingKey,
    deployer: params.record.deployer,
    artifact: params.record.artifact,
    deploymentsFile: params.deploymentsFile,
    dryRun: false,
  };
}
