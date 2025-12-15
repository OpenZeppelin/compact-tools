/**
 * Configuration constants for the Compact compiler CLI.
 * This is the single source of truth for all version definitions.
 */

/** Default source directory containing .compact files */
export const DEFAULT_SRC_DIR = 'src';

/** Default output directory for compiled artifacts */
export const DEFAULT_OUT_DIR = 'artifacts';

/**
 * Supported compactc compiler versions.
 * @note Update this array when new compiler versions are released.
 */
export const COMPACTC_VERSIONS = [
  '0.23.0',
  '0.24.0',
  '0.25.0',
  '0.26.0',
] as const;

/**
 * Supported compact-tools CLI versions.
 * @note Update this array when new CLI versions are released.
 */
export const COMPACT_TOOL_VERSIONS = ['0.1.0', '0.2.0', '0.3.0'] as const;

/** Latest supported compact-tools version */
export const LATEST_COMPACT_TOOL_VERSION =
  COMPACT_TOOL_VERSIONS[COMPACT_TOOL_VERSIONS.length - 1];

/** Maximum supported compactc version */
export const MAX_COMPACTC_VERSION =
  COMPACTC_VERSIONS[COMPACTC_VERSIONS.length - 1];

/** Type derived from supported compactc versions */
export type CompactcVersion = (typeof COMPACTC_VERSIONS)[number];

/** Type derived from supported compact-tools versions */
export type CompactToolVersion = (typeof COMPACT_TOOL_VERSIONS)[number];
