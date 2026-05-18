/**
 * Programmatic API surface for `@openzeppelin/compact-deploy`.
 *
 * Consumers that need to embed the deploy pipeline (CI runners, custom CLIs,
 * test harnesses) should import from this barrel. The `compact-deploy` binary
 * in `bin/` re-uses the same exports — it is just an opinionated shell.
 */
// biome-ignore-all lint/performance/noBarrelFile: this file is the programmatic API surface for consumers of @openzeppelin/compact-deploy
export { loadConfig } from './config/load.ts';
export type {
  CompactConfig,
  ContractConfig,
  NetworkConfig,
} from './config/schema.ts';
export { Deployments } from './deployments.ts';
export type {
  DeploymentRecord,
  DeploymentsFile,
  DeploymentsHistory,
} from './deployments.ts';
export type {
  PipelineOptions as DeployOptions,
  PipelineResult as DeployResult,
} from './pipeline.ts';
export { runPipeline as deploy } from './pipeline.ts';
export {
  ArtifactNotFoundError,
  ConfigError,
  DeployError,
  DeployTxFailedError,
  IndexerUnreachableError,
  ProofServerUnreachableError,
  UnfundedWalletError,
  WalletError,
} from './errors.ts';
export { Keystore } from './wallet/keystore.ts';
export type { MidnightKeystore } from './wallet/keystore.ts';
export { ProofServer } from './providers/proof-server.ts';
export {
  LOCAL_PREFUNDED_SEEDS,
  localPrefundedSeed,
} from './wallet/local-seeds.ts';
export { buildDeployerWallet } from './wallet/build-deployer.ts';
export { classifySeed } from './wallet/normalize.ts';
export type { WalletSeed } from './wallet/normalize.ts';
