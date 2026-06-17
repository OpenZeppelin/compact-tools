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

/** Proof server unreachable. Exit code `4`. */
export class ProofServerUnreachableError extends DeployError {
  constructor(url: string, options?: ErrorOptions) {
    super(`Proof server unreachable at ${url}`, 4, options);
    this.name = 'ProofServerUnreachableError';
  }
}

/** Indexer GraphQL endpoint unreachable. Exit code `4`. */
export class IndexerUnreachableError extends DeployError {
  constructor(url: string, options?: ErrorOptions) {
    super(`Indexer unreachable at ${url}`, 4, options);
    this.name = 'IndexerUnreachableError';
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
