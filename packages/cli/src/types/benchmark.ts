// Import types for structure and version
import type { ArtifactStructure } from './manifest.ts';
import type { CompactToolVersion } from '../config.ts';

/**
 * Contract type distinguishing between module and top-level contracts.
 * - 'module': A library/module contract with no circuits (no zkIR representation)
 * - 'top-level': A deployable contract with circuits and constraints
 */
export type ContractType = 'module' | 'top-level';

/**
 * Information about a compiled circuit.
 * Captured from compiler output like: `circuit "gt" (k=12, rows=2639)`
 *
 * @interface CircuitInfo
 */
export interface CircuitInfo {
  /** Circuit name (e.g., "gt", "gte", "transfer") */
  name: string;
  /** Circuit k parameter (determines proving key size, typically 10-20) */
  k: number;
  /** Number of rows/constraints in the circuit */
  rows: number;
}

/**
 * Contract benchmark entry with type and optional circuit information.
 * Uses flat path keys (e.g., "math/test/Bytes32.mock") for easy diffing.
 */
export interface BenchmarkContract {
  /** Contract type: 'module' or 'top-level' */
  type: ContractType;
  /** Circuit information (only present for top-level contracts) */
  circuits?: CircuitInfo[];
}

/**
 * Metadata about a compiled contract.
 * Alias for BenchmarkContract for use in compiler service.
 */
export type ContractMetadata = BenchmarkContract;

/**
 * A node in the hierarchical benchmarks tree.
 * Each node can contain contract metadata at its level and child directory nodes.
 *
 * @interface HierarchicalBenchmarkNode
 */
export interface HierarchicalBenchmarkNode {
  /** Contract metadata at this directory level, keyed by contract name */
  contracts?: Record<string, BenchmarkContract>;
  /** Child directories mapped by name to their benchmark nodes */
  [directory: string]:
    | Record<string, BenchmarkContract>
    | HierarchicalBenchmarkNode
    | undefined;
}

/**
 * Hierarchical benchmarks organized as a nested tree structure.
 * Mirrors the HierarchicalArtifacts structure but with contract metadata.
 *
 * @example
 * ```typescript
 * const benchmarks: HierarchicalBenchmarks = {
 *   math: {
 *     contracts: { "Bytes32": { type: "module" } },
 *     test: {
 *       contracts: { "Bytes32.mock": { type: "top-level", circuits: [...] } }
 *     }
 *   }
 * };
 * ```
 */
export type HierarchicalBenchmarks = Record<string, HierarchicalBenchmarkNode>;

/**
 * Benchmark report containing circuit metadata for all compiled contracts.
 * Designed to be committed to version control for tracking circuit complexity over time.
 *
 * @interface BenchmarkReport
 * @example Flattened structure
 * ```json
 * {
 *   "structure": "flattened",
 *   "compactcVersion": "0.26.0",
 *   "compactToolVersion": "compact 0.3.0",
 *   "contracts": {
 *     "AccessControl": { "type": "module" },
 *     "Bytes32.mock": {
 *       "type": "top-level",
 *       "circuits": [
 *         { "name": "gt", "k": 12, "rows": 2639 }
 *       ]
 *     }
 *   }
 * }
 * ```
 *
 * @example Hierarchical structure
 * ```json
 * {
 *   "structure": "hierarchical",
 *   "compactcVersion": "0.26.0",
 *   "compactToolVersion": "compact 0.3.0",
 *   "contracts": {
 *     "math": {
 *       "contracts": { "Bytes32": { "type": "module" } },
 *       "test": {
 *         "contracts": {
 *           "Bytes32.mock": {
 *             "type": "top-level",
 *             "circuits": [{ "name": "gt", "k": 12, "rows": 2639 }]
 *           }
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 */
export interface BenchmarkReport {
  /** The artifact structure type used during compilation */
  structure: ArtifactStructure;
  /** The compactc compiler version used for compilation */
  compactcVersion: string;
  /** The compact-tools CLI version used for compilation */
  compactToolVersion?: CompactToolVersion;
  /**
   * Contract benchmarks.
   * - For 'flattened' structure: flat record keyed by artifact name
   * - For 'hierarchical' structure: nested tree structure matching artifacts
   */
  contracts: Record<string, BenchmarkContract> | HierarchicalBenchmarks;
}

/** Default filename for the benchmark report */
export const BENCHMARK_FILENAME = 'benchmarks.json';
