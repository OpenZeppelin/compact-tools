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
