import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractConfig } from '../config/schema.ts';
import type { DeploymentRecord } from '../deployments.ts';
import { DeployTxFailedError } from '../errors.ts';
import type { Artifact } from '../loaders/artifact.ts';
import { formatError } from './error-format.ts';

export type ContractDeployResult = Awaited<ReturnType<typeof deployContract>>;

export interface ExecuteDeployArgs {
  providers: Parameters<typeof deployContract>[0];
  contractName: string;
  contract: ContractConfig;
  artifact: Artifact;
  signingKey: string;
  args: readonly unknown[];
  initialPrivateState: unknown;
}

/** Submit the deploy tx; wrap failures in {@link DeployTxFailedError}. */
export async function executeDeploy({
  providers,
  contractName,
  contract,
  artifact,
  signingKey,
  args,
  initialPrivateState,
}: ExecuteDeployArgs): Promise<ContractDeployResult> {
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
      `Deploy of "${contractName}" failed: ${formatError(e)}`,
      { cause: e },
    );
  }
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

export function toDeploymentRecord({
  deployTxData,
  deployer,
  artifact,
}: {
  deployTxData: ContractDeployResult['deployTxData'];
  deployer: string;
  artifact: string;
}): DeploymentRecord {
  return {
    address: deployTxData.public.contractAddress,
    txHash: deployTxData.public.txHash,
    txId: deployTxData.public.txId,
    blockHeight: deployTxData.public.blockHeight,
    deployer,
    artifact,
    timestamp: new Date().toISOString(),
  };
}
