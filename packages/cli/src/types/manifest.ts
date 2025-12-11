// Import and re-export version types from config (single source of truth)
import type { CompactcVersion, CompactToolVersion } from '../config.ts';

/**
 * A node in the hierarchical artifacts tree.
 * Each node can contain artifacts at its level and child directory nodes.
 *
 * @interface HierarchicalArtifactNode
 */
export interface HierarchicalArtifactNode {
  /** Artifacts at this directory level */
  artifacts?: string[];
  /** Child directories mapped by name to their artifact nodes */
  [directory: string]: string[] | HierarchicalArtifactNode | undefined;
}

/**
 * Hierarchical artifacts organized as a nested tree structure.
 * Each top-level key is a root directory, containing nested subdirectories.
 *
 * @example
 * ```typescript
 * const artifacts: HierarchicalArtifacts = {
 *   math: {
 *     artifacts: ['Bytes32', 'Field254', 'Uint128'],
 *     interfaces: {
 *       artifacts: ['IUint128', 'IUint256', 'IUint64']
 *     },
 *     test: {
 *       artifacts: ['Bytes32.mock', 'Field254.mock', 'Uint128.mock']
 *     }
 *   },
 *   access: {
 *     artifacts: ['AccessControl'],
 *     test: {
 *       artifacts: ['AccessControl.mock']
 *     }
 *   }
 * };
 * ```
 */
export type HierarchicalArtifacts = Record<string, HierarchicalArtifactNode>;

/**
 * Artifact structure type for output organization.
 * - 'flattened': All artifacts in a flat directory structure
 * - 'hierarchical': Artifacts organized by source directory structure
 */
export type ArtifactStructure = 'flattened' | 'hierarchical';

/**
 * Supported Node.js major versions.
 */
export type NodeVersion = '18' | '20' | '21' | '22' | '23' | '24' | '25';

/**
 * Supported platform identifiers.
 * Format: <os>-<arch>
 */
export type Platform =
  | 'linux-x64'
  | 'linux-arm64'
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'win32-x64'
  | 'win32-arm64';

/**
 * Known flags for the `compact compile` command (compactc).
 * These are passed directly to the Compact compiler.
 *
 * Boolean flags:
 * - `--skip-zk` - Skip generation of proving keys
 * - `--vscode` - Format error messages for VS Code extension
 * - `--no-communications-commitment` - Omit contract communications commitment
 * - `--trace-passes` - Print tracing info (for compiler developers)
 *
 * Value flags:
 * - `--sourceRoot <value>` - Override sourceRoot in source-map file
 */
export type CompilerFlag =
  | '--skip-zk'
  | '--vscode'
  | '--no-communications-commitment'
  | '--trace-passes'
  | `--sourceRoot ${string}`;

/**
 * Represents the artifact manifest stored in the output directory.
 * Used to track the structure type and metadata of compiled artifacts.
 *
 * @interface ArtifactManifest
 */
export interface ArtifactManifest {
  /** The artifact structure type used during compilation */
  structure: ArtifactStructure;
  /** The compactc compiler version used for compilation */
  compactcVersion?: CompactcVersion;
  /** The compact-tools CLI version used for compilation */
  compactToolVersion?: CompactToolVersion;
  /**
   * ISO 8601 timestamp when artifacts were created.
   * Format: YYYY-MM-DDTHH:mm:ss.sssZ
   * @example "2025-12-11T10:09:46.023Z"
   */
  createdAt: string;
  /** Total compilation duration in milliseconds */
  buildDuration?: number;
  /** Node.js major version used for compilation */
  nodeVersion?: NodeVersion;
  /** Platform identifier (os-arch) */
  platform?: Platform;
  /** Path to the source directory containing .compact files */
  sourcePath?: string;
  /** Path to the output directory where artifacts are written */
  outputPath?: string;
  /**
   * Compiler flags used during compilation.
   * @example "--skip-zk"
   * @example ["--skip-zk", "--no-communications-commitment"]
   */
  compilerFlags?: CompilerFlag | CompilerFlag[];
  /**
   * Artifact names that were created.
   * - For 'flattened' structure: flat array of artifact names
   * - For 'hierarchical' structure: nested tree structure with directories containing artifacts and child directories
   */
  artifacts: string[] | HierarchicalArtifacts;
}

/** Filename for the artifact manifest */
export const MANIFEST_FILENAME = 'manifest.json';

/**
 * Custom error thrown when artifact structure mismatch is detected
 * and user confirmation is required.
 *
 * @class StructureMismatchError
 * @extends Error
 */
export class StructureMismatchError extends Error {
  public readonly existingStructure: ArtifactStructure;
  public readonly requestedStructure: ArtifactStructure;

  constructor(
    existingStructure: ArtifactStructure,
    requestedStructure: ArtifactStructure,
  ) {
    super(
      `Artifact structure mismatch: existing="${existingStructure}", requested="${requestedStructure}"`,
    );
    this.name = 'StructureMismatchError';
    this.existingStructure = existingStructure;
    this.requestedStructure = requestedStructure;
  }
}
