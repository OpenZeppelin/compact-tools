import chalk from 'chalk';
import ora from 'ora';
import type { CompactcVersion, CompactToolVersion } from '../config.ts';

/**
 * Utility service for handling user interface output and formatting.
 * Provides consistent styling and formatting for compiler messages and output.
 *
 * @example
 * ```typescript
 * UIService.displayEnvInfo('0.3.0', '0.26.0', 'security');
 * UIService.printOutput('Compilation successful', chalk.green);
 * ```
 */
export const UIService = {
  /**
   * Prints formatted output with consistent indentation and coloring.
   * Filters empty lines and adds consistent indentation for readability.
   *
   * @param output - Raw output text to format
   * @param colorFn - Chalk color function for styling
   * @example
   * ```typescript
   * UIService.printOutput(stdout, chalk.cyan);
   * UIService.printOutput(stderr, chalk.red);
   * ```
   */
  printOutput(output: string, colorFn: (text: string) => string): void {
    const lines = output
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => `    ${line}`);
    console.log(colorFn(lines.join('\n')));
  },

  /**
   * Displays environment information including tool versions and configuration.
   * Shows compact-tools CLI version, compactc version, and optional settings.
   *
   * @param compactToolVersion - Version of the compact-tools CLI
   * @param compactcVersion - Version of the compactc compiler
   * @param targetDir - Optional target directory being compiled
   * @param version - Optional specific version being used
   * @example
   * ```typescript
   * UIService.displayEnvInfo('0.3.0', '0.26.0', 'security', '0.26.0');
   * ```
   */
  displayEnvInfo(
    compactToolVersion: CompactToolVersion,
    compactcVersion: CompactcVersion,
    targetDir?: string,
    version?: string,
  ): void {
    const spinner = ora();

    if (targetDir) {
      spinner.info(chalk.blue(`[COMPILE] TARGET_DIR: ${targetDir}`));
    }

    spinner.info(chalk.blue(`[COMPILE] compact-tools: ${compactToolVersion}`));
    spinner.info(chalk.blue(`[COMPILE] compactc: ${compactcVersion}`));

    if (version) {
      spinner.info(chalk.blue(`[COMPILE] Using compactc version: ${version}`));
    }
  },

  /**
   * Displays compilation start message with file count and optional location.
   *
   * @param fileCount - Number of files to be compiled
   * @param targetDir - Optional target directory being compiled
   * @example
   * ```typescript
   * UIService.showCompilationStart(5, 'security');
   * // Output: "Found 5 .compact file(s) to compile in security/"
   * ```
   */
  showCompilationStart(fileCount: number, targetDir?: string): void {
    const searchLocation = targetDir ? ` in ${targetDir}/` : '';
    const spinner = ora();
    spinner.info(
      chalk.blue(
        `[COMPILE] Found ${fileCount} .compact file(s) to compile${searchLocation}`,
      ),
    );
  },

  /**
   * Displays a warning message when no .compact files are found.
   *
   * @param targetDir - Optional target directory that was searched
   * @example
   * ```typescript
   * UIService.showNoFiles('security');
   * // Output: "No .compact files found in security/."
   * UIService.showNoFiles();
   * // Output: "No .compact files found."
   * ```
   */
  showNoFiles(targetDir?: string): void {
    const searchLocation = targetDir ? ` in ${targetDir}/` : '';
    const spinner = ora();
    spinner.warn(
      chalk.yellow(`[COMPILE] No .compact files found${searchLocation}.`),
    );
  },
};
