// Single root export — re-exports everything from the constituent libraries
// so consumers can pull anything off the umbrella with one import.
//
//   import { createSimulator, CompactCompiler, CompactBuilder } from '@openzeppelin/compact-tools';
//
// Each name is re-exported explicitly (rather than via `export *`) so the
// public surface is visible at a glance and biome's `noReExportAll` rule
// stays happy. When a new export is added in a constituent package, add it
// here too.

// @openzeppelin/compact-tools-builder
export type {
  BuilderOnlyOptions,
  BuilderOptions,
  BuildStep,
  CompilerOptions,
  CompilerServiceOptions,
  ExecFunction,
  PromisifiedChildProcessError,
} from '@openzeppelin/compact-tools-builder';
// biome-ignore lint/performance/noBarrelFile: package entrypoint
export {
  CompactBuilder,
  CompactCliNotFoundError,
  CompactCompiler,
  CompilationError,
  CompilerService,
  DirectoryNotFoundError,
  EnvironmentValidator,
  FileDiscovery,
  isPromisifiedChildProcessError,
  UIService,
} from '@openzeppelin/compact-tools-builder';

// @openzeppelin/compact-tools-simulator
export type {
  BaseSimulatorOptions,
  ContextlessCircuits,
  ExtractImpureCircuits,
  ExtractPureCircuits,
  IContractSimulator,
  IMinimalContract,
  SimulatorConfig,
} from '@openzeppelin/compact-tools-simulator';
export {
  AbstractSimulator,
  CircuitContextManager,
  ContractSimulator,
  createSimulator,
} from '@openzeppelin/compact-tools-simulator';
