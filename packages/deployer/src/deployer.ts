import { createHash } from 'node:crypto';
import type { ContractProviders } from '@midnight-ntwrk/midnight-js-contracts';
import type {
  FinalizedTxData,
  PrivateStateProvider,
} from '@midnight-ntwrk/midnight-js-types';
import type {
  EnvironmentConfiguration,
  MidnightWalletProvider,
} from '@midnight-ntwrk/testkit-js';
import type { Logger } from 'pino';
import { CompactConfig } from './config/compact-config.ts';
import type { ContractConfig, NetworkConfig } from './config/schema.ts';
import type {
  DeploymentRecord,
  DeploymentsPaths,
  PartialDeploymentRecord,
  PendingDeploymentRecord,
} from './deployments.ts';
import { Deployments } from './deployments.ts';
import {
  BlockLimitError,
  ConfigError,
  DeployError,
  DeploymentsFileError,
  FragmentDeployError,
} from './errors.ts';
import { ConstructorArgs } from './loaders/args.ts';
import { Artifact, type ArtifactKeys } from './loaders/artifact.ts';
import { InitialPrivateState } from './loaders/init-state.ts';
import { SigningKey } from './loaders/signing-key.ts';
import { buildProviders } from './providers/build.ts';
import { applyNetwork } from './providers/network.ts';
import { ProofServer } from './providers/proof-server.ts';
import {
  assertResumable,
  awaitCircuitsOnChain,
  type ChainSnapshot,
  readSnapshot,
  signerIndex,
  verifyState,
} from './services/chain-state.ts';
import {
  type Fragment,
  fragmentRemainder,
  planFragments,
  remaining,
  sortCircuits,
} from './services/deploy-plan.ts';
import {
  awaitDeployFinalization,
  awaitDeployTxData,
  awaitFinalization,
  awaitFragmentFinalization,
  buildExplorerUrl,
  DEFAULT_TX_TIMEOUT_MS,
  persistDeployPrivateState,
  submitDeploy,
  submitInsert,
  toConfirmedRecord,
  toPartialRecord,
  toPendingRecord,
} from './services/deploy-tx.ts';
import { formatError } from './services/error-format.ts';
import {
  buildInsertTx,
  buildInsertUpdate,
  verifyingKeyOf,
} from './services/maintenance-tx.ts';
import {
  awaitDustSettled,
  DEFAULT_SYNC_TIMEOUT_MS,
  logWalletAddresses,
  readDustTip,
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
   * deploy over it. On a `partial` head this abandons the unfinished deploy and
   * starts a new contract at a new address. Argv: `--force`.
   */
  force?: boolean;
  /**
   * Verifier keys per transaction. Set it when a contract is too large for one
   * deploy tx: fragment 0 rides the deploy and the rest arrive as batched
   * maintenance updates, all within this one `deploy()` call. Left unset, the
   * deployer tries a single tx and halves on a block-limit refusal.
   * Argv: `--circuits-per-tx`, TOML: `[contracts.X].circuits_per_tx`.
   */
  circuitsPerTx?: number;
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
  /**
   * `1` for a single-tx deploy. For a split, the deploy tx plus every
   * maintenance update the address has ever taken, read off the on-chain CMA
   * counter, so it includes inserts from an interrupted run and any made out
   * of band.
   */
  fragments: number;
  /** Artifact circuit count on a single-tx deploy; chain-verified on a split. */
  circuits: number;
}

/** Deploy-tx identifiers, however this run came by them. */
interface StartedDeployBase {
  address: string;
  txId: string;
  txHash: string;
  blockHeight: number;
}

/** A deploy that fitted one transaction. Nothing else to do but confirm it. */
interface SingleDeploy extends StartedDeployBase {
  kind: 'single';
  record: PendingDeploymentRecord;
}

/** Shared by the two ways a split deploy can already be under way. */
interface SplitDeployBase extends StartedDeployBase {
  record: PartialDeploymentRecord;
  /** Fragments still to insert, in order. Never includes fragment 0. */
  inserts: readonly Fragment[];
  /** Batch size the node last accepted, carried across fragments. */
  size: number;
}

/**
 * The deploy tx, landed. `kind` is what the fragment loop branches on: a fresh
 * split has to wait for its own fragment 0 to appear on chain, while a resume
 * already holds the read its guard took.
 */
type StartedDeploy =
  | SingleDeploy
  | (SplitDeployBase & {
      kind: 'fresh';
      /** Circuits the deploy tx carried. */
      fragmentZero: readonly string[];
      /** Dust tip read before the accepted deploy submission. */
      tip: bigint;
    })
  | (SplitDeployBase & { kind: 'resumed'; snapshot: ChainSnapshot });

interface PreparedState {
  opts: DeployerOptions;
  logger: Logger;
  config: CompactConfig;
  networkName: string;
  network: NetworkConfig;
  contract: ContractConfig;
  signingKey: SigningKey;
  /**
   * Verifier keys per transaction, resolved once: programmatic > TOML.
   * `undefined` means no explicit budget, which is what makes halving allowed.
   */
  budget: number | undefined;
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
    // INV-6: checked here so a bad budget fails before the wallet sync, which
    // on a real network is tens of minutes.
    assertBudget(opts.circuitsPerTx);
    const budget = opts.circuitsPerTx ?? contract.circuits_per_tx;
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
      budget,
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
   * Deploy the contract and leave a `confirmed` record under
   * `deployments/<network>.json`.
   *
   * A contract that fits one tx takes the single-tx path unchanged. A larger
   * one is split: fragment 0's verifier keys ride the deploy tx and the rest
   * arrive as batched maintenance updates, all inside this call. The record
   * written after submission is what makes either path recoverable: every
   * later failure leaves the address on disk and names it in the error.
   *
   * INV-29: a `partial` head record resumes from chain state unless `--force`
   * is set, in which case it is rotated into history and a new contract is
   * deployed. Resuming is idempotent: only the circuits still missing on chain
   * are inserted.
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
    const head = await deployments.getHead(contractName);
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
    const txTimeoutMs = s.opts.txTimeoutMs ?? DEFAULT_TX_TIMEOUT_MS;
    // INV-11: a bundle missing a key fails here, before any transaction.
    const keys = await s.artifact.verifierKeys(providers.zkConfigProvider);

    // INV-26: a partial head resumes; only --force starts a second contract.
    const started =
      head?.status === 'partial' && !force
        ? await this.#resumeAt({ head, providers, keys, txTimeoutMs })
        : await this.#deployFragmentZero({
            providers,
            deployments,
            txTimeoutMs,
            force,
          });

    const counts =
      started.kind === 'single'
        ? { fragments: 1, circuits: s.artifact.circuitNames.length }
        : await this.#finishSplit({
            providers,
            deployments,
            started,
            keys,
            txTimeoutMs,
          });

    const record = toConfirmedRecord({
      previous: started.record,
      txHash: started.txHash,
      blockHeight: started.blockHeight,
    });
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
      fragments: counts.fragments,
      circuits: counts.circuits,
    };
  }

  /**
   * Land every remaining fragment, then verify the address against the
   * artifact. Only a pass here lets the caller write `confirmed`.
   */
  async #finishSplit(args: {
    providers: ContractProviders;
    deployments: Deployments;
    started: Exclude<StartedDeploy, SingleDeploy>;
    keys: ArtifactKeys;
    txTimeoutMs: number;
  }): Promise<{ fragments: number; circuits: number }> {
    const progress = await this.#insertRemaining(args);
    // INV-11, INV-15: strict verify gates the promotion to `confirmed`.
    verifyState({
      address: args.started.address,
      artifactKeys: args.keys,
      snapshot: progress.snapshot,
      authority: progress.authority,
    });
    return {
      fragments: progress.fragments,
      circuits: progress.snapshot.circuits.length,
    };
  }

  /**
   * Submit the deploy tx, record it, wait for it to land, and persist private
   * state.
   */
  async #deployFragmentZero(args: {
    providers: ContractProviders;
    deployments: Deployments;
    txTimeoutMs: number;
    force: boolean;
  }): Promise<StartedDeploy> {
    const { providers, deployments, txTimeoutMs, force } = args;
    const s = this.#state;
    const contractName = s.opts.contract;
    const circuits = sortCircuits(s.artifact.circuitNames);
    // Checked before proving: submitting a tx we would then refuse to record
    // costs the user fees for nothing.
    await deployments.assertRecordable(contractName, { force });

    const attempt = await this.#submitHalving({
      circuits,
      size: s.budget ?? Math.max(circuits.length, 1),
      what: 'Deploy tx',
      submit: (batch) =>
        submitDeploy({
          providers,
          contractName,
          contract: s.contract,
          artifact: s.artifact,
          signingKey: s.signingKey.hex,
          args: s.args.values,
          initialPrivateState: s.initialPrivateState?.value,
          circuits: batch,
        }),
    });
    const submitted = attempt.result;
    const fragments = planFragments(circuits, attempt.cap).fragments;
    const split = fragments.length > 1;

    // INV-21: nothing is written until the node has accepted the tx.
    const record: PendingDeploymentRecord | PartialDeploymentRecord = split
      ? toPartialRecord({
          address: submitted.address,
          txId: submitted.txId,
          deployer: s.deployer,
          artifact: s.contract.artifact,
          circuits,
          circuitsOnChain: [],
        })
      : toPendingRecord({
          submitted,
          deployer: s.deployer,
          artifact: s.contract.artifact,
        });
    await this.#persist(record, () =>
      deployments.record(contractName, record, { force }),
    );

    const finalized = await awaitDeployFinalization({
      providers,
      contractName,
      submitted,
      txTimeoutMs,
      recovery: record.status === 'partial' ? 'partial' : 'pending',
    });
    // Order copied from midnight-js's own post-success path, and reached only
    // on `SucceedEntirely`. INV-18: the signing key and the initial private
    // state are stored once, for an address that now exists.
    await persistDeployPrivateState({
      providers,
      contract: s.contract,
      submitted,
    });

    const base = {
      address: submitted.address,
      txId: submitted.txId,
      txHash: finalized.txHash,
      blockHeight: finalized.blockHeight,
    };
    if (record.status !== 'partial') {
      return { kind: 'single', ...base, record };
    }
    s.logger.info(
      `Deploy tx landed with ${attempt.batch.length}/${circuits.length} circuits, txId ${submitted.txId}, block ${finalized.blockHeight}`,
    );
    return {
      kind: 'fresh',
      ...base,
      record,
      inserts: fragments.slice(1),
      size: attempt.cap,
      fragmentZero: attempt.batch,
      tip: attempt.tip,
    };
  }

  /**
   * Adopt a `partial` head after checking the recorded address really is our
   * unfinished contract. Nothing is submitted if any check fails.
   */
  async #resumeAt(args: {
    head: PartialDeploymentRecord;
    providers: ContractProviders;
    keys: ArtifactKeys;
    txTimeoutMs: number;
  }): Promise<StartedDeploy> {
    const { head, providers, keys, txTimeoutMs } = args;
    const s = this.#state;
    // INV-24: only the public half of the loaded key is compared or logged.
    const verifyingKey = verifyingKeyOf(s.signingKey.hex);
    s.logger.debug(
      `Resuming ${head.address}; maintenance verifying key ${verifyingKey}`,
    );
    // Settle the deploy transaction first, keyed by address. A run killed
    // between submission and finalization leaves a record whose contract is
    // still landing, and reading chain state before it does would report no
    // contract and send the operator to --force, which deploys a second one.
    const landed = await this.#settleDeployTx({ head, providers, txTimeoutMs });
    // An insert the previous run submitted but never saw land may since have
    // landed, so settle it before reading the state the plan is built from.
    const settledInsert =
      head.pendingTxId === undefined
        ? undefined
        : await this.#settlePendingInsert({
            providers,
            txId: head.pendingTxId,
            circuits: head.pendingCircuits ?? [],
            txTimeoutMs,
          });
    // INV-13: a pending insert that turns out to have landed still has to be
    // visible before the plan is built from chain state.
    if (settledInsert !== undefined) {
      await awaitCircuitsOnChain({
        publicDataProvider: providers.publicDataProvider,
        address: head.address,
        expected: settledInsert,
        timeoutMs: txTimeoutMs,
      });
    }
    // INV-27: address exists, committee is ours, on-chain keys match the
    // artifact. The record's own circuit lists are never consulted.
    const snapshot = assertResumable({
      address: head.address,
      artifactKeys: keys,
      snapshot: await this.#readSnapshotOrFail(head, providers),
      verifyingKey,
    });
    const left = remaining([...keys.keys()], snapshot.circuits);
    s.logger.info(
      `Resuming fragmented deploy of ${head.address}: ${snapshot.circuits.length}/${keys.size} circuits on chain`,
    );
    // INV-18: a resume of a deploy started on another machine, or after the
    // private-state store was cleared, has no key for this address.
    await this.#ensureSigningKeyStored({ providers, address: head.address });
    // Chain state exists, so the deploy landed. Prefer what the indexer just
    // said over the record, and fall back to the record only when the
    // address-keyed watch timed out.
    const txHash = landed?.txHash ?? head.txHash;
    const blockHeight = landed?.blockHeight ?? head.blockHeight;
    if (txHash === undefined || blockHeight === undefined) {
      throw new FragmentDeployError({
        address: head.address,
        circuitsOnChain: snapshot.circuits,
        circuitsPending: left,
        reason: `the deploy transaction of ${head.address} could not be identified, so the deploy cannot be confirmed`,
      });
    }
    const budget = s.budget ?? Math.max(left.length, 1);
    return {
      kind: 'resumed',
      address: head.address,
      txId: head.txId,
      txHash,
      blockHeight,
      record: head,
      // The resumed plan spans only what is left on chain.
      inserts: planFragments(left, budget).fragments,
      size: budget,
      snapshot,
    };
  }

  /**
   * Wait for the recorded address to have a landed deploy transaction.
   *
   * INV-2: `undefined` on timeout, which lets the resume guard report "no
   * contract there" rather than this wait masking it. A recorded `txHash` that
   * disagrees with the chain means the record points at someone else's deploy.
   */
  async #settleDeployTx(args: {
    head: PartialDeploymentRecord;
    providers: ContractProviders;
    txTimeoutMs: number;
  }): Promise<FinalizedTxData | undefined> {
    const { head, providers, txTimeoutMs } = args;
    const s = this.#state;
    let landed: FinalizedTxData;
    try {
      landed = await awaitDeployTxData({
        providers,
        address: head.address,
        txTimeoutMs,
        fail: (reason, detail) =>
          detail?.timedOut === true
            ? new DeployError(reason)
            : new FragmentDeployError(
                {
                  address: head.address,
                  circuitsOnChain: head.circuitsOnChain,
                  circuitsPending: head.circuitsPending,
                  reason: `the deploy transaction of ${head.address} did not succeed: ${reason}`,
                },
                { cause: detail?.cause },
              ),
      });
    } catch (e) {
      if (e instanceof FragmentDeployError) throw e;
      s.logger.debug(
        `No landed deploy transaction at ${head.address} yet: ${formatError(e)}`,
      );
      return undefined;
    }
    if (head.txHash !== undefined && head.txHash !== landed.txHash) {
      throw new ConfigError(
        `Deployments ledger records txHash ${head.txHash} for ${head.address}, but the chain reports ${landed.txHash}. Repair the record, or re-run with --force to deploy fresh.`,
      );
    }
    return landed;
  }

  /** Read chain state, reporting a read failure as the resumable error. */
  async #readSnapshotOrFail(
    head: PartialDeploymentRecord,
    providers: ContractProviders,
  ): Promise<ChainSnapshot | undefined> {
    try {
      return await readSnapshot(providers.publicDataProvider, head.address);
    } catch (e) {
      throw new FragmentDeployError(
        {
          address: head.address,
          circuitsOnChain: head.circuitsOnChain,
          circuitsPending: head.circuitsPending,
          reason: `chain state at ${head.address} could not be read: ${formatError(e)}`,
        },
        { cause: e },
      );
    }
  }

  /**
   * Wait out an insert the previous run left in flight, and report the circuits
   * it carried if it landed.
   *
   * The chain read that follows is the truth either way, so a failure here only
   * gets logged; the caller uses the returned circuits to make sure a landed one
   * is visible before it plans.
   */
  async #settlePendingInsert(args: {
    providers: ContractProviders;
    txId: string;
    circuits: readonly string[];
    txTimeoutMs: number;
  }): Promise<readonly string[] | undefined> {
    const { providers, txId, circuits, txTimeoutMs } = args;
    const { logger } = this.#state;
    logger.info(
      `Settling the insert left in flight by the previous run: ${txId}`,
    );
    try {
      await awaitFinalization({
        providers,
        txId,
        txTimeoutMs,
        fail: (reason) => new DeployError(reason),
      });
    } catch (e) {
      logger.info(`Insert ${txId} did not land: ${formatError(e)}`);
      return undefined;
    }
    logger.info(`Insert ${txId} landed after the previous run stopped`);
    return circuits;
  }

  /** Store the signing key for `address` when the private-state store lacks it. */
  async #ensureSigningKeyStored(args: {
    providers: ContractProviders;
    address: string;
  }): Promise<void> {
    const { providers, address } = args;
    const s = this.#state;
    if (
      (await providers.privateStateProvider.getSigningKey(address)) !== null
    ) {
      return;
    }
    s.logger.debug(`Storing the maintenance signing key for ${address}`);
    providers.privateStateProvider.setContractAddress(address);
    await providers.privateStateProvider.setSigningKey(
      address,
      s.signingKey.hex,
    );
  }

  /**
   * Submit the largest batch the node will take, halving on its refusal.
   *
   * INV-9: the only halving site. Strictly decreasing, floor one circuit, and
   * only when no explicit budget was given. INV-19: each attempt records the
   * dust index the wallet must pass before it can have seen that spend.
   */
  async #submitHalving<T>(args: {
    circuits: readonly string[];
    size: number;
    /** Names the transaction kind in the retry log line. */
    what: string;
    submit: (batch: readonly string[]) => Promise<T>;
  }): Promise<{
    batch: readonly string[];
    /** Largest batch the node has accepted, to cap the next one. */
    cap: number;
    tip: bigint;
    result: T;
  }> {
    const s = this.#state;
    // The cap survives a short batch: a fragment with two circuits left must
    // not shrink the size every later fragment is allowed.
    let cap = Math.max(1, args.size);
    for (;;) {
      const batch = args.circuits.slice(0, cap);
      const tip = await readDustTip(s.wallet);
      try {
        return { batch, cap, tip, result: await args.submit(batch) };
      } catch (e) {
        const halvable =
          e instanceof BlockLimitError &&
          s.budget === undefined &&
          batch.length > 1;
        if (!halvable) throw e;
        cap = Math.floor(batch.length / 2);
        s.logger.info(
          `${args.what} too large at ${batch.length} circuits; retrying with ${cap} per tx`,
        );
      }
    }
  }

  /**
   * Insert the verifier keys that are still missing, one batched maintenance
   * update per fragment, strictly sequentially.
   *
   * INV-30: every failure inside the loop leaves the `partial` record on disk
   * and names the address and both circuit lists, so a re-run resumes.
   */
  async #insertRemaining(args: {
    providers: ContractProviders;
    deployments: Deployments;
    started: Exclude<StartedDeploy, SingleDeploy>;
    keys: ArtifactKeys;
    txTimeoutMs: number;
  }): Promise<{
    fragments: number;
    snapshot: ChainSnapshot;
    authority: Pick<ChainSnapshot, 'committee' | 'threshold'>;
  }> {
    const { providers, deployments, started, keys, txTimeoutMs } = args;
    const s = this.#state;
    const contractName = s.opts.contract;
    const { address, record } = started;
    const all = [...keys.keys()];

    // INV-13: the next fragment is built from a read that already shows
    // fragment 0, never from a state the indexer has not caught up to. This
    // read raises the resumable error itself, so it sits outside the catch.
    let snapshot =
      started.kind === 'resumed'
        ? started.snapshot
        : await awaitCircuitsOnChain({
            publicDataProvider: providers.publicDataProvider,
            address,
            expected: started.fragmentZero,
            timeoutMs: txTimeoutMs,
          });
    const authority = {
      committee: snapshot.committee,
      threshold: snapshot.threshold,
    };
    let size = started.size;

    try {
      // INV-19: the wallet has to have applied the deploy tx's dust spend
      // before the first insert is balanced against the same UTXO set. A
      // resume has no spend of its own in flight.
      await (started.kind === 'fresh'
        ? awaitDustSettled({
            wallet: s.wallet,
            appliedBeyond: started.tip,
            timeoutMs: txTimeoutMs,
          })
        : Promise.resolve());
      // INV-25: the ledger checks each signature against a committee slot, so
      // the slot comes from the same chain read as the counter.
      const signer = signerIndex({
        address,
        snapshot,
        verifyingKey: verifyingKeyOf(s.signingKey.hex),
      });
      await this.#recordProgress({
        deployments,
        record,
        started,
        snapshot,
        all,
      });

      for (const fragment of started.inserts) {
        // INV-10: chain-derived, so an insert never names a key already there.
        let pending = fragmentRemainder(fragment, snapshot.circuits);
        while (pending.length > 0) {
          const landed = await this.#insertBatch({
            providers,
            deployments,
            started,
            keys,
            all,
            pending,
            size,
            snapshot,
            signer,
            txTimeoutMs,
          });
          snapshot = landed.snapshot;
          size = landed.size;
          pending = fragmentRemainder(fragment, snapshot.circuits);
        }
      }
      // Chain-derived: the CMA counter is 0 at deploy and rises by exactly one
      // per landed update, including any from an earlier interrupted run.
      return { fragments: 1 + Number(snapshot.counter), snapshot, authority };
    } catch (e) {
      // A ledger-write failure and a config problem keep their own exit codes:
      // neither is fixed by re-running. Everything else, block-limit
      // exhaustion included, becomes the resumable error.
      if (e instanceof DeploymentsFileError) throw e;
      if (e instanceof ConfigError) throw e;
      if (e instanceof FragmentDeployError) throw e;
      throw new FragmentDeployError(
        {
          address,
          circuitsOnChain: snapshot.circuits,
          circuitsPending: remaining(all, snapshot.circuits),
          reason: `inserting verifier keys for "${contractName}" failed: ${formatError(e)}`,
        },
        { cause: e },
      );
    }
  }

  /**
   * Land one batch of verifier keys: submit (halving on refusal), wait, confirm
   * it on chain, let the wallet catch up, and rewrite the progress record.
   */
  async #insertBatch(args: {
    providers: ContractProviders;
    deployments: Deployments;
    started: Exclude<StartedDeploy, SingleDeploy>;
    keys: ArtifactKeys;
    all: readonly string[];
    pending: readonly string[];
    size: number;
    snapshot: ChainSnapshot;
    signer: number;
    txTimeoutMs: number;
  }): Promise<{ snapshot: ChainSnapshot; size: number }> {
    const {
      providers,
      deployments,
      started,
      keys,
      all,
      pending,
      size,
      signer,
      txTimeoutMs,
    } = args;
    const s = this.#state;
    const { address, record } = started;
    let snapshot = args.snapshot;

    const attempt = await this.#submitHalving({
      circuits: pending,
      size,
      what: 'Insert',
      submit: (batch) =>
        submitInsert({
          providers,
          contractName: s.opts.contract,
          circuits: batch,
          // INV-28: counter read fresh from the snapshot above.
          unprovenTx: buildInsertTx({
            update: buildInsertUpdate({
              address,
              counter: snapshot.counter,
              signingKey: s.signingKey.hex,
              signerIndex: signer,
              inserts: batch.map((circuitId) => ({
                circuitId,
                verifierKey: keyOf(keys, circuitId),
              })),
            }),
          }),
        }),
    });
    const txId = attempt.result;

    try {
      await awaitFragmentFinalization({
        providers,
        address,
        txId,
        txTimeoutMs,
        circuitsOnChain: snapshot.circuits,
        circuitsPending: remaining(all, snapshot.circuits),
      });
    } catch (e) {
      // INV-29: only a tx still in flight is worth settling on the next run.
      // One the node ruled on is cleared, so a resume does not wait on it.
      const stillInFlight = e instanceof FragmentDeployError && e.timedOut;
      try {
        await this.#recordProgress({
          deployments,
          record,
          started,
          snapshot,
          all,
          ...(stillInFlight
            ? { pendingTxId: txId, pendingCircuits: attempt.batch }
            : {}),
        });
      } catch (writeFailure) {
        // The insert failure is the one the operator has to act on, so the
        // reporting write must not replace it.
        s.logger.warn(
          { err: formatError(writeFailure) },
          'Could not record progress for the stopped insert',
        );
      }
      throw e;
    }

    snapshot = await awaitCircuitsOnChain({
      publicDataProvider: providers.publicDataProvider,
      address,
      expected: attempt.batch,
      timeoutMs: txTimeoutMs,
    });
    const left = remaining(all, snapshot.circuits);
    // INV-19: only when another insert follows; nothing is balanced after the
    // last one.
    if (left.length > 0) {
      await awaitDustSettled({
        wallet: s.wallet,
        appliedBeyond: attempt.tip,
        timeoutMs: txTimeoutMs,
      });
    }
    s.logger.info(
      `Inserted ${attempt.batch.length} circuit(s): ${snapshot.circuits.length}/${all.length} on chain, txId ${txId}`,
    );
    await this.#recordProgress({ deployments, record, started, snapshot, all });
    return { snapshot, size: attempt.cap };
  }

  /** Refresh the `partial` head from a chain snapshot. Reporting only. */
  async #recordProgress(args: {
    deployments: Deployments;
    record: PartialDeploymentRecord;
    started: StartedDeployBase;
    snapshot: ChainSnapshot;
    all: readonly string[];
    /** An insert this run submitted but never saw land, and its circuits. */
    pendingTxId?: string;
    pendingCircuits?: readonly string[];
  }): Promise<void> {
    const {
      deployments,
      record,
      started,
      snapshot,
      all,
      pendingTxId,
      pendingCircuits,
    } = args;
    const progress = toPartialRecord({
      address: started.address,
      txId: started.txId,
      deployer: record.deployer,
      artifact: record.artifact,
      circuits: all,
      circuitsOnChain: snapshot.circuits,
      submittedAt: record.submittedAt,
      txHash: started.txHash,
      blockHeight: started.blockHeight,
      pendingTxId,
      pendingCircuits,
    });
    await this.#persist(progress, () =>
      deployments.updatePartial(this.#state.opts.contract, progress),
    );
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
      fragments: 0,
      circuits: s.artifact.circuitNames.length,
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
      // A refused record is the user's to fix, and its ConfigError already
      // says how; wrapping it would hide the exit code and the instruction.
      if (e instanceof ConfigError) throw e;
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

/** A fragment budget is a whole number of circuits, at least one. */
function assertBudget(budget: number | undefined): void {
  if (budget === undefined) return;
  if (!Number.isInteger(budget) || budget < 1) {
    throw new ConfigError(
      `circuits_per_tx must be an integer >= 1; got ${budget}.`,
    );
  }
}

/**
 * Verifier key bytes for `circuitId`. `Artifact.verifierKeys` refuses a bundle
 * that is missing one, so every name in the plan has an entry.
 */
function keyOf(keys: ArtifactKeys, circuitId: string): Uint8Array {
  return keys.get(circuitId) as Uint8Array;
}

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
