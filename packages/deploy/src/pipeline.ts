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
import { ConstructorArgs } from './loaders/args.ts';
import { Artifact } from './loaders/artifact.ts';
import { CompactConfig } from './config/compact-config.ts';
import type { ContractConfig, NetworkConfig } from './config/schema.ts';
import { ConfigError, DeployTxFailedError } from './errors.ts';
import { InitialPrivateState } from './loaders/init-state.ts';
import { Deployments, type DeploymentRecord } from './deployments.ts';
import { buildProviders } from './providers/build.ts';
import { applyNetwork } from './providers/network.ts';
import { ProofServer } from './providers/proof-server.ts';
import { SigningKey } from './loaders/signing-key.ts';
import { buildDeployerWallet } from './wallet/build-deployer.ts';
import { type SeedResolution, resolveSeed } from './wallet/resolve.ts';

/**
 * Inputs to {@link runPipeline}. The CLI in `bin/compact-deploy.ts` is a
 * thin shell that fills these out from argv + env; embedders can construct
 * them directly to skip TOML lookup or to inject a shared wallet.
 */
export interface PipelineOptions {
  contract: string;
  network?: string;
  configPath?: string;
  seedFile?: string;
  proofServer?: string;
  skipFaucet?: boolean;
  dryRun?: boolean;
  argsOverride?: string;
  initPrivateStateOverride?: string;
  logger: Logger;
  promptPassphrase?: (path: string) => Promise<string>;
  /**
   * Inject an already-built, already-started `MidnightWalletProvider`. When
   * set, the pipeline skips seed resolution, wallet build, faucet calls,
   * `wallet.start()`, and `wallet.stop()` — the caller owns the wallet's
   * lifecycle.
   *
   * Use this when running many deploys in a single Node process (e.g.
   * integration test suites). Each `buildDeployerWallet` rebuilds a wallet
   * that syncs from the indexer; under rapid back-to-back deploys the
   * indexer can lag and the new wallet sees an already-spent dust UTXO,
   * producing a `DustDoubleSpend` rejection. Sharing one wallet across
   * the deploys keeps its UTXO view internally consistent.
   */
  walletProvider?: MidnightWalletProvider;
}

/** Final shape returned by {@link runPipeline}; identical in dry-run mode except `dryRun: true` and the on-chain fields are empty. */
export interface PipelineResult {
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
 * End-to-end deploy: config → wallet → faucet → providers → submit → persist.
 *
 * Reads as a linear recipe — every step is a named helper below. Two
 * resources need explicit cleanup (the proof-server container if `"auto"`,
 * and an owned wallet); both are wrapped in `try/finally` here so the
 * helpers can stay free of teardown logic.
 */
export async function runPipeline(
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const { logger } = opts;

  const config = await CompactConfig.load(opts.configPath);
  const { rootDir } = config;
  const { networkName, network, contract } = resolveTargets(opts, config);

  const signingKey = await SigningKey.load(rootDir, contract.signing_key_file);
  const seedResolution = await maybeResolveSeed(opts, {
    config,
    networkName,
    network,
  });
  if (seedResolution) {
    logger.debug(`Resolved deployer seed from: ${seedResolution.origin}`);
  }

  const proofServer = await ProofServer.start({
    cliOverride: opts.proofServer,
    network,
    logger,
  });
  try {
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

    const { wallet, ownsWallet } = await acquireWallet(
      opts,
      env,
      seedResolution,
      logger,
    );
    try {
      if (ownsWallet) {
        await maybeRequestFaucet(opts, wallet, env, network, logger);
        await wallet.start(true);
      }

      const providers = buildProviders({
        env,
        wallet,
        contractName: opts.contract,
        contract,
        zkConfigPath: artifact.zkConfigPath,
      });

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

      if (opts.dryRun) {
        logDryRun(logger, {
          contractName: opts.contract,
          networkName,
          artifact,
          argCount: args.length,
          hasPrivateState: initialPrivateState !== undefined,
          faucet: !!network.faucet && !opts.skipFaucet,
          faucetUrl,
          deployer,
        });
        return dryRunResult({
          contractName: opts.contract,
          networkName,
          signingKey: signingKey.hex,
          deployer,
          artifact: contract.artifact,
        });
      }

      const txResult = await executeDeploy({
        providers,
        contractName: opts.contract,
        contract,
        artifact,
        signingKey: signingKey.hex,
        args: args.values,
        initialPrivateState: initialPrivateState?.value,
      });

      const record = toDeploymentRecord({
        deployTxData: txResult.deployTxData,
        signingKey: signingKey.hex,
        deployer,
        artifact: contract.artifact,
      });

      const deployments = new Deployments({
        rootDir,
        deploymentsDir: config.deploymentsDir,
        network: networkName,
      });
      const persistResult = await deployments.record(opts.contract, record);

      return successResult({
        contractName: opts.contract,
        networkName,
        record,
        deploymentsFile: persistResult.head,
      });
    } finally {
      if (ownsWallet) await safeStopWallet(wallet, logger);
    }
  } finally {
    await safeDisposeProofServer(proofServer, logger);
  }
}

// ---------------------------------------------------------------------------
// Helpers — every step of runPipeline lives in its own function. Order
// roughly follows the order each helper runs.
// ---------------------------------------------------------------------------

interface ResolvedTargets {
  networkName: string;
  network: NetworkConfig;
  contract: ContractConfig;
}

/**
 * Pick the network and contract from `compact.toml`, defaulting the network
 * to `[profile].default_network` when `--network` isn't passed. Throws
 * {@link ConfigError} with the available set on each invalid lookup.
 */
function resolveTargets(
  opts: PipelineOptions,
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
 * Resolve a deployer seed unless the caller injected its own wallet
 * (`opts.walletProvider` set). Returning `undefined` is the signal to
 * {@link acquireWallet} that it should adopt the injected wallet instead of
 * building one.
 */
async function maybeResolveSeed(
  opts: PipelineOptions,
  ctx: {
    config: CompactConfig;
    networkName: string;
    network: NetworkConfig;
  },
): Promise<SeedResolution | undefined> {
  if (opts.walletProvider) return undefined;
  return resolveSeed({
    config: ctx.config,
    networkName: ctx.networkName,
    network: ctx.network,
    seedFile: opts.seedFile,
    promptPassphrase: opts.promptPassphrase,
  });
}

interface AcquiredWallet {
  wallet: MidnightWalletProvider;
  /** True when the pipeline built the wallet itself and is therefore responsible for `start`/`stop`. */
  ownsWallet: boolean;
}

/**
 * Either return the caller-injected wallet (and skip the lifecycle) or
 * build a fresh one from the resolved seed (and own its lifecycle).
 */
async function acquireWallet(
  opts: PipelineOptions,
  env: EnvironmentConfiguration,
  seedResolution: SeedResolution | undefined,
  logger: Logger,
): Promise<AcquiredWallet> {
  if (opts.walletProvider) {
    return { wallet: opts.walletProvider, ownsWallet: false };
  }
  if (!seedResolution) {
    // Should be unreachable — maybeResolveSeed returns a value whenever
    // walletProvider is undefined — but the explicit check keeps the type
    // narrowing local instead of relying on the caller.
    throw new Error('internal: resolvedSeed missing for owned wallet');
  }
  const wallet = await buildDeployerWallet(logger, env, seedResolution.seed);
  return { wallet, ownsWallet: true };
}

/**
 * Hit the network's faucet for the deployer address when configured
 * (`[networks.X].faucet = true`, not `--skip-faucet`, and the resolved
 * `env.faucet` URL is present). Safe to call before `wallet.start()` — we
 * read the unshielded address from the wallet's already-running state
 * stream.
 */
async function maybeRequestFaucet(
  opts: PipelineOptions,
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

type DeployResult = Awaited<ReturnType<typeof deployContract>>;

/** Map the midnight-js deploy-tx result into the persisted record shape. */
function toDeploymentRecord({
  deployTxData,
  signingKey,
  deployer,
  artifact,
}: {
  deployTxData: DeployResult['deployTxData'];
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

/** Emit the same structured `dry-run: would deploy` event the old pipeline did. */
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

/** Build the `PipelineResult` returned from a dry run (no on-chain fields). */
function dryRunResult(params: {
  contractName: string;
  networkName: string;
  signingKey: string;
  deployer: string;
  artifact: string;
}): PipelineResult {
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

/** Build the `PipelineResult` returned from a confirmed deploy. */
function successResult(params: {
  contractName: string;
  networkName: string;
  record: DeploymentRecord;
  deploymentsFile: string;
}): PipelineResult {
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

/** Stop the wallet, swallowing teardown errors with a `warn` log. */
async function safeStopWallet(
  wallet: MidnightWalletProvider,
  logger: Logger,
): Promise<void> {
  try {
    await wallet.stop();
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'Wallet stop failed');
  }
}

/** Dispose the proof-server container, swallowing teardown errors with a `warn` log. */
async function safeDisposeProofServer(
  proofServer: ProofServer,
  logger: Logger,
): Promise<void> {
  try {
    await proofServer.dispose();
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'Proof server dispose failed');
  }
}
