import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import ora from 'ora';
import {
  type CompactcVersion,
  type CompactToolVersion,
  LATEST_COMPACT_TOOL_VERSION,
  MAX_COMPACTC_VERSION,
  resolveCompactExecutable,
} from '../config.ts';
import { CompactCliNotFoundError } from '../types/errors.ts';

/**
 * Compares two semver version strings.
 * @param a - First version string (e.g., "0.26.0")
 * @param b - Second version string (e.g., "0.27.0")
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
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

/**
 * Function type for executing shell commands.
 * Allows dependency injection for testing and customization.
 *
 * @param command - The shell command to execute
 * @returns Promise resolving to command output
 */
export type ExecFunction = (
  command: string,
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Service responsible for validating the Compact CLI environment.
 * Checks CLI availability, retrieves version information, and ensures
 * the toolchain is properly configured before compilation.
 *
 * @class EnvironmentValidator
 * @example
 * ```typescript
 * const validator = new EnvironmentValidator();
 * await validator.validate('0.26.0');
 * const version = await validator.getCompactToolVersion();
 * ```
 */
export class EnvironmentValidator {
  private execFn: ExecFunction;
  private compactExecutable: string;

  /**
   * Creates a new EnvironmentValidator instance.
   *
   * @param execFn - Function to execute shell commands (defaults to promisified child_process.exec)
   */
  constructor(execFn: ExecFunction = promisify(execCallback)) {
    this.execFn = execFn;
    // Resolve compact executable path from standard install locations
    this.compactExecutable = resolveCompactExecutable();
  }

  /**
   * Checks if the Compact CLI is available in the system PATH.
   *
   * @returns Promise resolving to true if CLI is available, false otherwise
   * @example
   * ```typescript
   * const isAvailable = await validator.checkCompactAvailable();
   * if (!isAvailable) {
   *   throw new Error('Compact CLI not found');
   * }
   * ```
   */
  async checkCompactAvailable(): Promise<boolean> {
    try {
      await this.execFn(`${this.compactExecutable} --version`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieves the version of the Compact developer tools.
   *
   * @returns Promise resolving to the version string
   * @throws {Error} If the CLI is not available or command fails
   * @example
   * ```typescript
   * const version = await validator.getCompactToolVersion();
   * console.log(`Using Compact ${version}`);
   * ```
   */
  async getCompactToolVersion(): Promise<string> {
    const { stdout } = await this.execFn(`${this.compactExecutable} --version`);
    return stdout.trim();
  }

  /**
   * Retrieves the version of the Compact toolchain/compiler.
   *
   * @param version - Optional specific toolchain version to query
   * @returns Promise resolving to the compactc version
   * @throws {Error} If the CLI is not available or command fails
   * @example
   * ```typescript
   * const compactcVersion = await validator.getCompactcVersion('0.26.0');
   * console.log(`Compiler: ${compactcVersion}`);
   * ```
   */
  async getCompactcVersion(version?: string): Promise<string> {
    const versionFlag = version ? `+${version}` : '';
    const { stdout } = await this.execFn(
      `${this.compactExecutable} compile ${versionFlag} --version`,
    );
    return stdout.trim();
  }

  /**
   * Validates the entire Compact environment and ensures it's ready for compilation.
   * Checks CLI availability and retrieves version information.
   *
   * @param version - Optional specific toolchain version to validate
   * @throws {CompactCliNotFoundError} If the Compact CLI is not available
   * @throws {Error} If version commands fail or compactc version is unsupported
   * @example
   * ```typescript
   * try {
   *   await validator.validate('0.26.0');
   *   console.log('Environment validated successfully');
   * } catch (error) {
   *   if (error instanceof CompactCliNotFoundError) {
   *     console.error('Please install Compact CLI');
   *   }
   * }
   * ```
   */
  async validate(version?: string): Promise<{
    compactToolVersion: CompactToolVersion;
    compactcVersion: CompactcVersion;
  }> {
    const isAvailable = await this.checkCompactAvailable();
    if (!isAvailable) {
      throw new CompactCliNotFoundError(
        "'compact' CLI not found in PATH. Please install the Compact developer tools.",
      );
    }

    const compactToolVersion = await this.getCompactToolVersion();
    const compactcVersion = await this.getCompactcVersion(version);

    // Warn if compact-tools version is older than latest
    if (compareVersions(compactToolVersion, LATEST_COMPACT_TOOL_VERSION) < 0) {
      const spinner = ora();
      spinner.warn(
        chalk.yellow(
          `[COMPILE] compact-tools ${compactToolVersion} is outdated. ` +
            `Run 'compact self update' to update to ${LATEST_COMPACT_TOOL_VERSION} or later.`,
        ),
      );
    }

    // Error if compactc version is newer than supported
    if (compareVersions(compactcVersion, MAX_COMPACTC_VERSION) > 0) {
      throw new Error(
        `compactc ${compactcVersion} is not yet supported. ` +
          `Maximum supported version is ${MAX_COMPACTC_VERSION}. ` +
          'Please update compact-tools or use an older compiler version.',
      );
    }

    return {
      compactToolVersion: compactToolVersion as CompactToolVersion,
      compactcVersion: compactcVersion as CompactcVersion,
    };
  }
}
