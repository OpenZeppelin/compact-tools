import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/** Name of the compact executable */
export const COMPACT_EXECUTABLE = 'compact';

/**
 * Standard install paths for the Compact CLI.
 * Based on the dist-workspace.toml install-path configuration:
 * - $XDG_BIN_HOME/
 * - $XDG_DATA_HOME/../bin (typically ~/.local/bin)
 * - ~/.local/bin
 *
 * @see https://github.com/midnightntwrk/compact-export/blob/main/dist-workspace.toml
 */
export function getCompactInstallPaths(): string[] {
  const paths: string[] = [];
  const home = homedir();

  // $XDG_BIN_HOME takes priority if set
  const xdgBinHome = process.env.XDG_BIN_HOME;
  if (xdgBinHome) {
    paths.push(xdgBinHome);
  }

  // $XDG_DATA_HOME/../bin (defaults to ~/.local/share/../bin = ~/.local/bin)
  const xdgDataHome =
    process.env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  paths.push(join(xdgDataHome, '..', 'bin'));

  // ~/.local/bin as fallback
  paths.push(join(home, '.local', 'bin'));

  return paths;
}

/**
 * Resolves the absolute path to the compact executable.
 * Checks standard install locations first, then falls back to PATH resolution.
 *
 * @returns Absolute path to compact executable if found in standard locations,
 *          otherwise returns 'compact' for PATH resolution
 */
export function resolveCompactExecutable(): string {
  const installPaths = getCompactInstallPaths();

  for (const dir of installPaths) {
    const executablePath = join(dir, COMPACT_EXECUTABLE);
    if (existsSync(executablePath)) {
      return executablePath;
    }
  }

  // Fall back to PATH resolution
  return COMPACT_EXECUTABLE;
}
