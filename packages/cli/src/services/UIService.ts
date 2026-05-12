import chalk from 'chalk';
import ora from 'ora';

/**
 * Utility service for handling user interface output and formatting.
 * Provides consistent styling and formatting for compiler messages and output.
 *
 * @example
 * ```typescript
 * UIService.displayEnvInfo('compact 0.1.0', 'Compactc 0.26.0', 'security');
 * UIService.printOutput('Compilation successful', chalk.green);
 * ```
 */
export const UIService = {
  /**
   * Prints formatted output with consistent indentation and coloring.
   * Filters empty lines and adds consistent indentation for readability.
   *
   * @param output  - Raw output text to format
   * @param colorFn - Chalk color function for styling
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
   * Shows developer tools version, toolchain version, and optional settings.
   *
   * @param devToolsVersion  - Version string of the Compact developer tools
   * @param toolchainVersion - Version string of the Compact toolchain/compiler
   * @param targetDir        - Optional target directory being compiled
   * @param version          - Optional specific version being used
   */
  displayEnvInfo(
    devToolsVersion: string,
    toolchainVersion: string,
    targetDir?: string,
    version?: string,
  ): void {
    const spinner = ora();

    if (targetDir) {
      spinner.info(chalk.blue(`[COMPILE] TARGET_DIR: ${targetDir}`));
    }

    spinner.info(
      chalk.blue(`[COMPILE] Compact developer tools: ${devToolsVersion}`),
    );
    spinner.info(
      chalk.blue(`[COMPILE] Compact toolchain: ${toolchainVersion}`),
    );

    if (version) {
      spinner.info(chalk.blue(`[COMPILE] Using toolchain version: ${version}`));
    }
  },

  /**
   * Displays compilation start message with file count and optional location.
   *
   * @param fileCount - Number of files to be compiled
   * @param targetDir - Optional target directory being compiled
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
   */
  showNoFiles(targetDir?: string): void {
    const searchLocation = targetDir ? `${targetDir}/` : '';
    const spinner = ora();
    spinner.warn(
      chalk.yellow(`[COMPILE] No .compact files found in ${searchLocation}.`),
    );
  },
};
