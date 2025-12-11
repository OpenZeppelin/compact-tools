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

/** Minimum supported compact-tools version */
export const MIN_COMPACT_TOOL_VERSION =
  COMPACT_TOOL_VERSIONS[COMPACT_TOOL_VERSIONS.length - 1];

/** Maximum supported compactc version */
export const MAX_COMPACTC_VERSION =
  COMPACTC_VERSIONS[COMPACTC_VERSIONS.length - 1];

/** Type derived from supported compactc versions */
export type CompactcVersion = (typeof COMPACTC_VERSIONS)[number];

/** Type derived from supported compact-tools versions */
export type CompactToolVersion = (typeof COMPACT_TOOL_VERSIONS)[number];

/**
 * Compares two semver version strings.
 * @param a - First version string (e.g., "0.26.0")
 * @param b - Second version string (e.g., "0.27.0")
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }
  return 0;
}
