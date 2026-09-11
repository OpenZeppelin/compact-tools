/**
 * Typed errors with stable `exitCode` per failure mode so `bin/compact-deploy`
 * (and CI scripts) can branch without parsing messages.
 */

/** Base deploy-pipeline failure. Default exit code `1`. */
export class DeployError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeployError';
    this.exitCode = exitCode;
  }
}

/** Config / TOML / schema. Exit code `2`. */
export class ConfigError extends DeployError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 2, options);
    this.name = 'ConfigError';
  }
}

/** Seed, keystore, or wallet construction. Exit code `3`. */
export class WalletError extends DeployError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 3, options);
    this.name = 'WalletError';
  }
}

/**
 * A prior deploy of the same contract is still pending on this network.
 * Exit code `2`.
 */
export class PendingDeployExistsError extends ConfigError {
  constructor(contractName: string, txId: string, options?: ErrorOptions) {
    super(
      `"${contractName}" already has a pending deploy (txId ${txId}) in the deployments ledger. Confirm whether that tx landed, then pass --force to overwrite the pending record.`,
      options,
    );
    this.name = 'PendingDeployExistsError';
  }
}

/**
 * A prior fragmented deploy of the same contract is unfinished on this network
 * and the caller asked for a fresh deploy anyway. Exit code `2`.
 */
export class PartialDeployExistsError extends ConfigError {
  constructor(contractName: string, address: string, options?: ErrorOptions) {
    super(
      `"${contractName}" has an unfinished fragmented deploy at ${address}. Re-run without --force to resume it, or keep --force to abandon it and deploy a new contract.`,
      options,
    );
    this.name = 'PartialDeployExistsError';
  }
}

/** Deployer wallet has zero balance. Exit code `3`. */
export class UnfundedWalletError extends DeployError {
  constructor(address: string, options?: ErrorOptions) {
    super(`Wallet ${address} has zero balance`, 3, options);
    this.name = 'UnfundedWalletError';
  }
}

/** Compiled artifact directory or required subfiles missing. Exit code `2`. */
export class ArtifactNotFoundError extends DeployError {
  constructor(path: string, options?: ErrorOptions) {
    super(
      `Compiled artifact not found at ${path}. Run \`compact-compiler\` to produce it.`,
      2,
      options,
    );
    this.name = 'ArtifactNotFoundError';
  }
}

/** On-chain submission rejected the tx. Exit code `5`. */
export class DeployTxFailedError extends DeployError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 5, options);
    this.name = 'DeployTxFailedError';
  }
}

/**
 * The node's tx pool refused a transaction as too large at the configured or
 * minimum fragment size. Exit code `7`: the tx was never admitted, so no fee
 * was charged, which is what separates it from a plain
 * {@link DeployTxFailedError}.
 *
 * Refused on the deploy tx, nothing is written at all. Refused on an insert,
 * the contract is already deployed, so the caller wraps this in a
 * {@link FragmentDeployError} and the `partial` record survives.
 */
export class BlockLimitError extends DeployTxFailedError {
  override readonly exitCode = 7;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BlockLimitError';
  }
}

export interface FragmentDeployErrorFields {
  address: string;
  /** Read from chain, not from the plan. */
  circuitsOnChain: readonly string[];
  circuitsPending: readonly string[];
  reason: string;
  /** The failed insert, when one was submitted. */
  txId?: string;
  /**
   * The wait hit its ceiling rather than the node ruling on the transaction,
   * so `txId` may still land.
   */
  timedOut?: boolean;
}

/**
 * A fragmented deploy stopped after the deploy tx landed. Exit code `8`.
 *
 * The contract exists and is callable with a subset of its circuits. The fields
 * are the whole reconciliation surface, and re-running the same deploy command
 * resumes from chain state. Carries no signing key.
 */
export class FragmentDeployError extends DeployError {
  readonly address: string;
  readonly circuitsOnChain: readonly string[];
  readonly circuitsPending: readonly string[];
  readonly txId: string | undefined;
  readonly timedOut: boolean;

  constructor(fields: FragmentDeployErrorFields, options?: ErrorOptions) {
    const { address, circuitsOnChain, circuitsPending, reason, txId } = fields;
    super(
      `Fragmented deploy of ${address} is incomplete: ${reason}. On chain: ${list(circuitsOnChain)}. Pending: ${list(circuitsPending)}.${txId ? ` Failed insert txId ${txId}.` : ''} The partial record is left in place; re-run the same deploy to resume.`,
      8,
      options,
    );
    this.name = 'FragmentDeployError';
    this.address = address;
    this.circuitsOnChain = circuitsOnChain;
    this.circuitsPending = circuitsPending;
    this.txId = txId;
    this.timedOut = fields.timedOut === true;
  }
}

function list(circuits: readonly string[]): string {
  return circuits.length > 0 ? circuits.join(', ') : '(none)';
}

/**
 * The deployments ledger could not be read or written. Exit code `6`, distinct
 * from every pre-submission code: the tx may already be on chain, so the
 * address and txId in the message are the only record of it.
 */
export class DeploymentsFileError extends DeployError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 6, options);
    this.name = 'DeploymentsFileError';
  }
}
