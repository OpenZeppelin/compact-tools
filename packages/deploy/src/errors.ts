/**
 * Typed error hierarchy with stable process exit codes.
 *
 * Each subclass pins a distinct `exitCode` so CI / scripts can branch on the
 * failure mode without parsing messages: 1 generic, 2 config, 3 wallet,
 * 4 network, 5 deploy-tx. The `bin/compact-deploy` shell reads `exitCode`
 * directly on catch.
 */

/** Base class for every deploy-pipeline failure. Default exit code is `1`. */
export class DeployError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeployError';
    this.exitCode = exitCode;
  }
}

/** Config / TOML / schema problems. Exit code `2`. */
export class ConfigError extends DeployError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 2, options);
    this.name = 'ConfigError';
  }
}

/** Seed resolution, keystore decryption, or wallet construction failures. Exit code `3`. */
export class WalletError extends DeployError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 3, options);
    this.name = 'WalletError';
  }
}

/** Proof server didn't respond. Exit code `4`. */
export class ProofServerUnreachableError extends DeployError {
  constructor(url: string, options?: ErrorOptions) {
    super(`Proof server unreachable at ${url}`, 4, options);
    this.name = 'ProofServerUnreachableError';
  }
}

/** Indexer GraphQL endpoint didn't respond. Exit code `4`. */
export class IndexerUnreachableError extends DeployError {
  constructor(url: string, options?: ErrorOptions) {
    super(`Indexer unreachable at ${url}`, 4, options);
    this.name = 'IndexerUnreachableError';
  }
}

/** Deployer wallet has zero balance and no faucet was hit (or faucet failed). Exit code `3`. */
export class UnfundedWalletError extends DeployError {
  constructor(
    address: string,
    faucetUrl: string | undefined,
    options?: ErrorOptions,
  ) {
    const hint = faucetUrl ? ` (faucet: ${faucetUrl})` : '';
    super(`Wallet ${address} has zero balance${hint}`, 3, options);
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

/** On-chain submission rejected the tx (proof invalid, fee too low, etc). Exit code `5`. */
export class DeployTxFailedError extends DeployError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 5, options);
    this.name = 'DeployTxFailedError';
  }
}
