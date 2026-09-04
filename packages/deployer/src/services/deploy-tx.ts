import {
  type ContractProviders,
  createUnprovenDeployTx,
  submitTxAsync,
} from '@midnight-ntwrk/midnight-js-contracts';
import {
  type FinalizedTxData,
  SucceedEntirely,
} from '@midnight-ntwrk/midnight-js-types';
import type { ContractConfig } from '../config/schema.ts';
import type {
  ConfirmedDeploymentRecord,
  PendingDeploymentRecord,
} from '../deployments.ts';
import { DeployTxFailedError } from '../errors.ts';
import type { Artifact } from '../loaders/artifact.ts';
import { formatError } from './error-format.ts';

/**
 * Ceiling on the wait for finalization. The indexer stops reporting on a tx
 * that never lands, and `watchForTxData` waits forever, so without a ceiling a
 * dropped WebSocket hangs the CLI with no way out but Ctrl-C.
 */
export const DEFAULT_TX_TIMEOUT_MS = 600_000;

type UnprovenDeployOptions = Parameters<typeof createUnprovenDeployTx>[1];

/** Constructor output plus the unproven tx, as returned by the SDK. */
type UnsubmittedDeploy = Awaited<ReturnType<typeof createUnprovenDeployTx>>;

export interface SubmitDeployArgs {
  providers: ContractProviders;
  contractName: string;
  contract: ContractConfig;
  artifact: Artifact;
  signingKey: string;
  args: readonly unknown[];
  initialPrivateState: unknown;
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
export async function submitDeploy({
  providers,
  contractName,
  contract,
  artifact,
  signingKey,
  args,
  initialPrivateState,
}: SubmitDeployArgs): Promise<SubmittedDeploy> {
  const compiled =
    artifact.compiledContract as UnprovenDeployOptions['compiledContract'];
  const base = {
    compiledContract: compiled,
    signingKey,
    args,
  } as UnprovenDeployOptions;
  const deployOptions =
    contract.private_state_id !== undefined
      ? { ...base, initialPrivateState }
      : base;

  try {
    const unsubmitted = await createUnprovenDeployTx(providers, deployOptions);
    const txId = await submitTxAsync(providers, {
      unprovenTx: unsubmitted.private.unprovenTx,
    });
    return {
      address: unsubmitted.public.contractAddress,
      txId,
      unsubmitted,
    };
  } catch (e) {
    throw new DeployTxFailedError(
      `Deploy of "${contractName}" failed: ${formatError(e)}`,
      { cause: e },
    );
  }
}

export interface AwaitDeployFinalizationArgs {
  providers: ContractProviders;
  contractName: string;
  submitted: SubmittedDeploy;
  txTimeoutMs: number;
}

/** Wait for the tx to land, capped at `txTimeoutMs`. Rejects on any non-`SucceedEntirely` status. */
export async function awaitDeployFinalization({
  providers,
  contractName,
  submitted,
  txTimeoutMs,
}: AwaitDeployFinalizationArgs): Promise<FinalizedTxData> {
  const { address, txId } = submitted;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finalized = await Promise.race([
    providers.publicDataProvider.watchForTxData(txId),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            unconfirmed(
              contractName,
              address,
              txId,
              `no finalization within ${txTimeoutMs} ms`,
            ),
          ),
        txTimeoutMs,
      );
    }),
  ])
    .catch((e: unknown) => {
      throw e instanceof DeployTxFailedError
        ? e
        : unconfirmed(contractName, address, txId, formatError(e), e);
    })
    .finally(() => clearTimeout(timer));

  if (finalized.status !== SucceedEntirely) {
    throw unconfirmed(
      contractName,
      address,
      txId,
      `the node reported status "${finalized.status}"`,
    );
  }
  return finalized;
}

export interface PersistDeployPrivateStateArgs {
  providers: ContractProviders;
  contract: ContractConfig;
  submitted: SubmittedDeploy;
}

/**
 * Store the signing key and initial private state for the deployed address.
 * Call only after a `SucceedEntirely` status: a rejected tx must not leave
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

export function toConfirmedRecord({
  pending,
  finalized,
}: {
  pending: PendingDeploymentRecord;
  finalized: FinalizedTxData;
}): ConfirmedDeploymentRecord {
  return {
    status: 'confirmed',
    address: pending.address,
    txId: pending.txId,
    deployer: pending.deployer,
    artifact: pending.artifact,
    txHash: finalized.txHash,
    blockHeight: finalized.blockHeight,
    timestamp: new Date().toISOString(),
  };
}

/**
 * The tx is out of our hands and its ledger record stays pending, so the
 * message has to carry every identifier needed to reconcile by hand.
 */
function unconfirmed(
  contractName: string,
  address: string,
  txId: string,
  reason: string,
  cause?: unknown,
): DeployTxFailedError {
  return new DeployTxFailedError(
    `Deploy of "${contractName}" was submitted but not confirmed: ${reason}. address ${address}, txId ${txId}. The pending record in the deployments ledger is left in place; check the tx on chain, then re-run with --force to replace it.`,
    cause !== undefined ? { cause } : undefined,
  );
}
