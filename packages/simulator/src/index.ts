// biome-ignore-all lint/performance/noBarrelFile: package entrypoint

// --- Backend seam ----------------------------------------------------------
export type { Backend, BackendKind, CircuitKind } from './backend/Backend.js';
export type { SyncSimulator } from './backend/DryBackend.js';
export { DryBackend } from './backend/DryBackend.js';
export { AbstractSimulator } from './core/AbstractSimulator.js';
export { CircuitContextManager } from './core/CircuitContextManager.js';
export { ContractSimulator } from './core/ContractSimulator.js';
// --- Core simulator (one factory, two backends) ----------------------------
// A dry import pulls zero midnight-js: the live adapter `LiveBackend`
// is type-only here and reached at runtime only via the dynamic import inside
// `createSimulator`. `createLiveContext`/`registerLiveBackend` are
// values, but their static graph is midnight-js-free (type-only + dynamic
// import), so exporting them from the main barrel keeps the wall up.
export { createSimulator } from './factory/createSimulator.js';
export type { SimulatorConfig } from './factory/SimulatorConfig.js';
export type {
  CreateLiveContextOptions,
  IndexerLagPolicy,
} from './live/createLiveContext.js';
// --- Live wiring (harness-facing) ------------------------------------------
export {
  createLiveContext,
  DEFAULT_INDEXER_LAG,
} from './live/createLiveContext.js';
export type { LiveBackend } from './live/LiveBackend.js';
export { WITNESS_OVERRIDE_UNSUPPORTED } from './live/LiveBackend.js';
export type {
  DeployedTxHandle,
  FinalizedCallResult,
  LiveContext,
} from './live/LiveContext.js';
export type {
  LiveBackendFactory,
  LiveBackendRequest,
} from './live/registry.js';
export {
  clearLiveBackend,
  getRegisteredLiveBackend,
  isLiveBackend,
  registerLiveBackend,
} from './live/registry.js';
export type {
  ContractAddress,
  Either,
  ZswapCoinPublicKey,
} from './signers/Signers.js';
// --- Signers ---------------------------------------------------------------
export {
  MAX_LIVE_SIGNERS,
  Signers,
  type SignersOptions,
} from './signers/Signers.js';

// --- Types -----------------------------------------------------------------
export type {
  AsyncCircuits,
  ContextlessCircuits,
  ExtractImpureCircuits,
  ExtractPureCircuits,
  IContractSimulator,
  IMinimalContract,
} from './types/index.js';
export type {
  BaseSimulatorOptions,
  SimulatorOptions,
} from './types/Options.js';
