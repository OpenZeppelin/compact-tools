import { ContractExecutable } from '@midnight-ntwrk/compact-js';
import { ContractDeploy, Intent, Transaction } from '@midnight-ntwrk/ledger-v8';
import {
  type ContractProviders,
  createUnprovenDeployTx,
  submitTxAsync,
} from '@midnight-ntwrk/midnight-js-contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  exitResultOrError,
  type FinalizedTxData,
  makeContractExecutableRuntime,
  type PrivateStateProvider,
  SucceedEntirely,
} from '@midnight-ntwrk/midnight-js-types';
import {
  parseCoinPublicKeyToHex,
  ttlOneHour,
} from '@midnight-ntwrk/midnight-js-utils';
import type { ContractConfig } from '../config/schema.ts';
import type {
  ConfirmedDeploymentRecord,
  PartialDeploymentRecord,
  PendingDeploymentRecord,
} from '../deployments.ts';
import {
  BlockLimitError,
  ConfigError,
  DeployError,
  DeployTxFailedError,
  FragmentDeployError,
} from '../errors.ts';
import type { Artifact } from '../loaders/artifact.ts';
import { pruneState } from './contract-state.ts';
import { remaining, sortCircuits } from './deploy-plan.ts';
import { formatError } from './error-format.ts';

/**
 * Ceiling on the wait for finalization. The indexer stops reporting on a tx
 * that never lands, and `watchForTxData` waits forever, so without a ceiling a
 * dropped WebSocket hangs the CLI with no way out but Ctrl-C.
 */
export const DEFAULT_TX_TIMEOUT_MS = 600_000;

/**
 * Whether a submission failure is the pool refusing an over-large extrinsic.
 *
 * The node returns `1010: Invalid Transaction: Transaction would exhaust the
 * block limits`, and that text is the only signal the pool gives: midnight-node
 * 0.22.2 exposes no `payment_queryInfo` and carries no transaction-payment
 * pallet, so the transaction cannot be weighed before submission. Both halves
 * are required, since other `1010` causes must stay ordinary tx failures.
 */
function isBlockLimitRejection(error: unknown): boolean {
  const text = formatError(error);
  return text.includes('1010') && /exhaust the block limits/i.test(text);
}

type UnprovenDeployOptions = Parameters<typeof createUnprovenDeployTx>[1];

/** An unproven tx as `submitTxAsync` accepts it. */
export type UnprovenTx = Parameters<typeof submitTxAsync>[1]['unprovenTx'];

/** The signing key as the private-state store accepts it. */
type PersistedSigningKey = Parameters<PrivateStateProvider['setSigningKey']>[1];

/**
 * The fields of a constructor result this package reads. Narrower than the
 * SDK's own return type, which both builders satisfy structurally, so neither
 * needs a cast.
 */
interface UnsubmittedDeploy {
  public: { contractAddress: string };
  private: {
    unprovenTx: UnprovenTx;
    signingKey: PersistedSigningKey;
    initialPrivateState: unknown;
  };
}

export interface SubmitDeployArgs {
  providers: ContractProviders;
  contractName: string;
  contract: ContractConfig;
  artifact: Artifact;
  signingKey: string;
  args: readonly unknown[];
  initialPrivateState: unknown;
  /**
   * Circuits whose verifier keys ride the deploy tx. The artifact's full list
   * takes the unmodified single-tx path; a subset prunes the constructor state
   * and the rest arrive as maintenance updates.
   */
  circuits: readonly string[];
}

/**
 * A deploy tx the node accepted. `address` and `txId` identify the contract
 * before finalization, which is what makes a pending ledger record possible.
 *
 * `unsubmitted` carries the signing key and the initial private state. Never
 * log or serialize it; {@link persistDeployPrivateState} is its only consumer.
 */
export interface SubmittedDeploy {
  address: string;
  txId: string;
  unsubmitted: UnsubmittedDeploy;
}

/**
 * Build and submit the deploy tx, returning as soon as the node accepts it.
 * Split from the wait for finalization so the caller can persist `txId`
 * first; `deployContract` fuses the two and yields no identifier until the
 * tx has already landed.
 */
export async function submitDeploy(
  submitArgs: SubmitDeployArgs,
): Promise<SubmittedDeploy> {
  const { providers, contractName, artifact, circuits } = submitArgs;
  const pruning = circuits.length < artifact.circuitNames.length;

  try {
    const unsubmitted = pruning
      ? await buildPrunedDeploy(submitArgs)
      : await buildFullDeploy(submitArgs);
    const txId = await submitClassified(
      `Deploy of "${contractName}"`,
      circuits.length,
      () =>
        submitTxAsync(providers, {
          unprovenTx: unsubmitted.private.unprovenTx,
        }),
    );
    return {
      address: unsubmitted.public.contractAddress,
      txId,
      unsubmitted,
    };
  } catch (e) {
    // Our own gates already carry the right exit code and message.
    if (e instanceof DeployError) throw e;
    throw new DeployTxFailedError(
      `Deploy of "${contractName}" failed: ${formatError(e)}`,
      { cause: e },
    );
  }
}

/**
 * Run `submit`, turning the pool's refusal of an over-large extrinsic into a
 * {@link BlockLimitError} the caller can halve on.
 *
 * INV-9: this is the only place a refusal becomes halvable, so the deploy tx
 * and every insert classify it identically.
 */
async function submitClassified(
  what: string,
  size: number,
  submit: () => Promise<string>,
): Promise<string> {
  try {
    return await submit();
  } catch (e) {
    if (isBlockLimitRejection(e)) {
      throw new BlockLimitError(
        `${what} was refused by the node as too large for one block at ${size} circuit(s): ${formatError(e)}`,
        { cause: e },
      );
    }
    throw e;
  }
}

/** INV-20: today's path, one tx carrying the constructor state and every verifier key. */
function buildFullDeploy({
  providers,
  contract,
  artifact,
  signingKey,
  args,
  initialPrivateState,
}: SubmitDeployArgs): Promise<UnsubmittedDeploy> {
  const base = {
    compiledContract: artifact.compiledContract,
    signingKey,
    args,
  } as UnprovenDeployOptions;
  const deployOptions =
    contract.private_state_id !== undefined
      ? { ...base, initialPrivateState }
      : base;
  return createUnprovenDeployTx(providers, deployOptions);
}

/**
 * Split path: run the constructor, keep only `circuits`' operations, and deploy
 * that state.
 *
 * `createUnprovenDeployTx` fuses the constructor call and the tx assembly with
 * no seam to prune between them, so this replicates its steps. The intent
 * carries no Zswap offer, which is why a constructor that creates coins is
 * refused rather than silently stripped.
 */
async function buildPrunedDeploy({
  providers,
  contractName,
  contract,
  artifact,
  signingKey,
  args,
  initialPrivateState,
  circuits,
}: SubmitDeployArgs): Promise<UnsubmittedDeploy> {
  const executable = ContractExecutable.make(artifact.compiledContract);
  const coinPublicKey = parseCoinPublicKeyToHex(
    providers.walletProvider.getCoinPublicKey(),
    getNetworkId(),
  );
  const runtime = makeContractExecutableRuntime(providers.zkConfigProvider, {
    coinPublicKey,
    signingKey,
  });
  const privateStateIn =
    contract.private_state_id !== undefined ? initialPrivateState : undefined;
  const constructed = exitResultOrError(
    await runtime.runPromiseExit(
      executable.initialize(privateStateIn, ...(args as never[])),
    ),
  );

  const { contractState } = constructed.public;
  const { privateState, zswapLocalState } = constructed.private;
  const coinCount =
    zswapLocalState.inputs.length + zswapLocalState.outputs.length;
  if (coinCount > 0) {
    // INV-8: the split tx has no Zswap offer, so the constructor's coins would
    // be lost. Deploy this contract in one tx or shrink it.
    throw new ConfigError(
      `Constructor of "${contractName}" creates or spends ${coinCount} Zswap coin(s), which a fragmented deploy cannot carry. Remove circuits_per_tx, or deploy a contract small enough for a single tx.`,
    );
  }

  const deploy = new ContractDeploy(
    pruneState({ state: contractState, keep: sortCircuits(circuits) }),
  );
  const unprovenTx = Transaction.fromParts(
    getNetworkId(),
    undefined,
    undefined,
    Intent.new(ttlOneHour()).addDeploy(deploy),
  );
  return {
    public: { contractAddress: deploy.address },
    private: {
      unprovenTx,
      signingKey: constructed.private.signingKey,
      initialPrivateState: privateState,
    },
  };
}

export interface AwaitDeployFinalizationArgs {
  providers: ContractProviders;
  contractName: string;
  submitted: SubmittedDeploy;
  txTimeoutMs: number;
  /** The record this deploy wrote, which is what the operator has to act on. */
  recovery: 'pending' | 'partial';
}

/**
 * INV-12: wait for one transaction to land, capped at `txTimeoutMs`, rejecting
 * any status other than `SucceedEntirely`.
 *
 * `fail` supplies the caller's error type, so the deploy tx and a fragment
 * insert share the ceiling and the status rule while reporting differently.
 */
export async function awaitFinalization({
  providers,
  txId,
  txTimeoutMs,
  fail,
}: {
  providers: ContractProviders;
  txId: string;
  txTimeoutMs: number;
  fail: FinalizationFail;
}): Promise<FinalizedTxData> {
  return settle(
    () => providers.publicDataProvider.watchForTxData(txId),
    txTimeoutMs,
    fail,
  );
}

/**
 * Settle the deploy transaction by address rather than by a recorded id.
 *
 * A `txId` read back from the deployments file may be corrupt, in which case a
 * watch on it never returns, or may belong to a different contract, in which
 * case it returns data that has nothing to do with this address.
 */
export async function awaitDeployTxData({
  providers,
  address,
  txTimeoutMs,
  fail,
}: {
  providers: ContractProviders;
  address: string;
  txTimeoutMs: number;
  fail: FinalizationFail;
}): Promise<FinalizedTxData> {
  return settle(
    () => providers.publicDataProvider.watchForDeployTxData(address),
    txTimeoutMs,
    fail,
  );
}

/**
 * INV-12: one wait, one ceiling, one `SucceedEntirely` rule. `fail` supplies
 * the caller's error type and learns whether the ceiling was what stopped it,
 * which is the difference between a transaction still in flight and one the
 * node has ruled on.
 */
type FinalizationFail = (
  reason: string,
  detail?: { cause?: unknown; timedOut?: boolean },
) => Error;

async function settle(
  watch: () => Promise<FinalizedTxData>,
  txTimeoutMs: number,
  fail: FinalizationFail,
): Promise<FinalizedTxData> {
  const finalized = await raceForTxData(watch, txTimeoutMs, () =>
    fail(`no finalization within ${txTimeoutMs} ms`, { timedOut: true }),
  ).catch((e: unknown) => {
    throw e instanceof DeployError ? e : fail(formatError(e), { cause: e });
  });

  if (finalized.status !== SucceedEntirely) {
    throw fail(`the node reported status "${finalized.status}"`);
  }
  return finalized;
}

/** Wait for the deploy tx to land. The pending record survives every failure. */
export function awaitDeployFinalization({
  providers,
  contractName,
  submitted,
  txTimeoutMs,
  recovery,
}: AwaitDeployFinalizationArgs): Promise<FinalizedTxData> {
  const { address, txId } = submitted;
  return awaitFinalization({
    providers,
    txId,
    txTimeoutMs,
    fail: (reason, detail) =>
      unconfirmed({
        contractName,
        address,
        txId,
        reason,
        recovery,
        cause: detail?.cause,
      }),
  });
}

export interface SubmitInsertArgs {
  providers: ContractProviders;
  contractName: string;
  unprovenTx: UnprovenTx;
  /** Circuits in this batch. Named in a block-limit refusal. */
  circuits: readonly string[];
}

/**
 * Submit one verifier-key insert, classifying a block-limit refusal the way
 * {@link submitDeploy} does so the caller can halve the batch and retry.
 */
export function submitInsert({
  providers,
  contractName,
  unprovenTx,
  circuits,
}: SubmitInsertArgs): Promise<string> {
  return submitClassified(
    `Verifier-key insert for "${contractName}"`,
    circuits.length,
    () => submitTxAsync(providers, { unprovenTx }),
  );
}

export interface AwaitFragmentFinalizationArgs {
  providers: ContractProviders;
  address: string;
  txId: string;
  txTimeoutMs: number;
  /** Reported in the error so a stopped run can be reconciled by hand. */
  circuitsOnChain: readonly string[];
  circuitsPending: readonly string[];
}

/**
 * INV-12: wait for one transaction of a fragmented deploy to land, under the
 * same ceiling and the same `SucceedEntirely` rule as the deploy tx. A partially
 * applied update must not be treated as landed: verify would then be skipped
 * for those circuits.
 */
export function awaitFragmentFinalization({
  providers,
  address,
  txId,
  txTimeoutMs,
  circuitsOnChain,
  circuitsPending,
}: AwaitFragmentFinalizationArgs): Promise<FinalizedTxData> {
  return awaitFinalization({
    providers,
    txId,
    txTimeoutMs,
    fail: (reason, detail) =>
      new FragmentDeployError(
        {
          address,
          circuitsOnChain,
          circuitsPending,
          reason,
          txId,
          timedOut: detail?.timedOut,
        },
        detail?.cause !== undefined ? { cause: detail.cause } : undefined,
      ),
  });
}

export interface PersistDeployPrivateStateArgs {
  providers: ContractProviders;
  contract: ContractConfig;
  submitted: SubmittedDeploy;
}

/**
 * INV-18: store the signing key and initial private state for the deployed
 * address. Call only after a `SucceedEntirely` status: a rejected tx must not leave
 * local state behind for a contract that does not exist.
 */
export async function persistDeployPrivateState({
  providers,
  contract,
  submitted,
}: PersistDeployPrivateStateArgs): Promise<void> {
  const { address, unsubmitted } = submitted;
  providers.privateStateProvider.setContractAddress(address);
  if (contract.private_state_id !== undefined) {
    await providers.privateStateProvider.set(
      contract.private_state_id,
      unsubmitted.private.initialPrivateState,
    );
  }
  await providers.privateStateProvider.setSigningKey(
    address,
    unsubmitted.private.signingKey,
  );
}

/** Build `<explorer>/contracts/0x<address>`, or `''` when no explorer / no address. */
export function buildExplorerUrl(
  base: string | undefined,
  address: string,
): string {
  if (!base || !address) return '';
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  const hex = address.startsWith('0x') ? address : `0x${address}`;
  return `${trimmed}/contracts/${hex}`;
}

export function toPendingRecord({
  submitted,
  deployer,
  artifact,
}: {
  submitted: SubmittedDeploy;
  deployer: string;
  artifact: string;
}): PendingDeploymentRecord {
  return {
    status: 'pending',
    address: submitted.address,
    txId: submitted.txId,
    deployer,
    artifact,
    submittedAt: new Date().toISOString(),
  };
}

export interface ToPartialRecordArgs {
  address: string;
  /** The deploy tx, carried unchanged across every progress rewrite. */
  txId: string;
  deployer: string;
  artifact: string;
  /** The artifact's full circuit list. */
  circuits: readonly string[];
  /** From the most recent chain read. */
  circuitsOnChain: readonly string[];
  submittedAt?: string;
  /** Deploy-tx identifiers, so a resume can promote without re-awaiting it. */
  txHash?: string;
  blockHeight?: number;
  /** An insert submitted but never seen to land, and the circuits it carried. */
  pendingTxId?: string;
  pendingCircuits?: readonly string[];
}

/**
 * INV-17: progress record for a fragmented deploy.
 *
 * `circuitsOnChain` must come from a chain read: a record built from the plan
 * would claim circuits landed whose insert actually failed.
 */
export function toPartialRecord({
  address,
  txId,
  deployer,
  artifact,
  circuits,
  circuitsOnChain,
  submittedAt,
  txHash,
  blockHeight,
  pendingTxId,
  pendingCircuits,
}: ToPartialRecordArgs): PartialDeploymentRecord {
  const all = sortCircuits(circuits);
  const onChain = sortCircuits(circuitsOnChain);
  // INV-17: the two lists partition the artifact's circuits, so a chain read
  // naming something the artifact does not have is a bug, not a user error.
  const foreign = remaining(onChain, all);
  if (foreign.length > 0) {
    throw new DeployError(
      `Chain state at ${address} reports circuits absent from the artifact: ${foreign.join(', ')}.`,
    );
  }
  return {
    status: 'partial',
    address,
    txId,
    deployer,
    artifact,
    circuitsOnChain: onChain,
    circuitsPending: remaining(all, onChain),
    submittedAt: submittedAt ?? new Date().toISOString(),
    ...(txHash !== undefined ? { txHash } : {}),
    ...(blockHeight !== undefined ? { blockHeight } : {}),
    ...(pendingTxId !== undefined ? { pendingTxId, pendingCircuits } : {}),
  };
}

export function toConfirmedRecord({
  previous,
  txHash,
  blockHeight,
}: {
  /** The head this deploy wrote: `pending` for a single tx, `partial` for a split. */
  previous: PendingDeploymentRecord | PartialDeploymentRecord;
  /** From the deploy tx's finalization, or carried across a resume. */
  txHash: string;
  blockHeight: number;
}): ConfirmedDeploymentRecord {
  return {
    status: 'confirmed',
    address: previous.address,
    txId: previous.txId,
    deployer: previous.deployer,
    artifact: previous.artifact,
    txHash,
    blockHeight,
    timestamp: new Date().toISOString(),
  };
}

/**
 * `watchForTxData` waits forever on a tx that never lands, so every wait needs
 * a ceiling. `onTimeout` supplies the caller's error type.
 */
function raceForTxData(
  watch: () => Promise<FinalizedTxData>,
  txTimeoutMs: number,
  onTimeout: () => Error,
): Promise<FinalizedTxData> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    watch(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(onTimeout()), txTimeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** How to get out of a stopped deploy, which differs by the record it left. */
const RECOVERY = {
  pending:
    'The pending record in the deployments ledger is left in place; check the tx on chain, then re-run with --force to replace it.',
  partial:
    'The partial record in the deployments ledger is left in place; re-run the same deploy to resume, or pass --force to abandon the landed contract and deploy a new one.',
} as const;

/**
 * The tx is out of our hands and its ledger record survives, so the message has
 * to carry every identifier needed to reconcile by hand.
 */
function unconfirmed({
  contractName,
  address,
  txId,
  reason,
  recovery,
  cause,
}: {
  contractName: string;
  address: string;
  txId: string;
  reason: string;
  recovery: keyof typeof RECOVERY;
  cause?: unknown;
}): DeployTxFailedError {
  return new DeployTxFailedError(
    `Deploy of "${contractName}" was submitted but not confirmed: ${reason}. address ${address}, txId ${txId}. ${RECOVERY[recovery]}`,
    cause !== undefined ? { cause } : undefined,
  );
}
