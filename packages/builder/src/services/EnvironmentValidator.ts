import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { CompactCliNotFoundError } from '../types/errors.ts';
import type { ExecFunction } from '../types/options.ts';

/**
 * Service responsible for validating the Compact CLI environment.
 * Checks CLI availability, retrieves version information, and ensures
 * the toolchain is properly configured before compilation.
 *
 * @example
 * ```typescript
 * const validator = new EnvironmentValidator();
 * await validator.validate('0.26.0');
 * const version = await validator.getDevToolsVersion();
 * ```
 */
export class EnvironmentValidator {
  private execFn: ExecFunction;

  /**
   * Creates a new EnvironmentValidator instance.
   *
   * @param execFn - Function to execute shell commands (defaults to promisified child_process.exec)
   */
  constructor(execFn: ExecFunction = promisify(execCallback)) {
    this.execFn = execFn;
  }

  /**
   * Checks if the Compact CLI is available in the system PATH.
   *
   * @returns Promise resolving to true if CLI is available, false otherwise
   */
  async checkCompactAvailable(): Promise<boolean> {
    try {
      await this.execFn('compact --version');
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
   */
  async getDevToolsVersion(): Promise<string> {
    const { stdout } = await this.execFn('compact --version');
    return stdout.trim();
  }

  /**
   * Retrieves the version of the Compact toolchain/compiler.
   *
   * @param version - Optional specific toolchain version to query
   * @returns Promise resolving to the toolchain version string
   * @throws {Error} If the CLI is not available or command fails
   */
  async getToolchainVersion(version?: string): Promise<string> {
    const versionFlag = version ? `+${version}` : '';
    const { stdout } = await this.execFn(
      `compact compile ${versionFlag} --version`,
    );
    return stdout.trim();
  }

  /**
   * Validates the entire Compact environment and ensures it's ready for compilation.
   * Checks CLI availability and retrieves version information.
   *
   * @param version - Optional specific toolchain version to validate
   * @throws {CompactCliNotFoundError} If the Compact CLI is not available
   * @throws {Error} If version commands fail
   */
  async validate(
    version?: string,
  ): Promise<{ devToolsVersion: string; toolchainVersion: string }> {
    const isAvailable = await this.checkCompactAvailable();
    if (!isAvailable) {
      throw new CompactCliNotFoundError(
        "'compact' CLI not found in PATH. Please install the Compact developer tools.",
      );
    }

    const devToolsVersion = await this.getDevToolsVersion();
    const toolchainVersion = await this.getToolchainVersion(version);

    return { devToolsVersion, toolchainVersion };
  }
}
