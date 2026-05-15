#!/usr/bin/env node

import { CompactBuilder } from '@openzeppelin/compact-builder';
import chalk from 'chalk';
import ora from 'ora';

/**
 * Executes the Compact builder CLI.
 * Builds projects using the `CompactBuilder` class with provided options, including compilation and additional steps.
 *
 * Compiler options (forwarded to `compact-compiler`):
 * - `--dir <directory>`  - Compile specific subdirectory within srcDir
 * - `--src <directory>`  - Source directory (default: src)
 * - `--out <directory>`  - Output directory for artifacts (default: artifacts)
 * - `--hierarchical`     - Preserve source directory structure in BOTH the
 *                          compiler artifacts output AND the builder's
 *                          .compact copy into dist/ (default off: flat in both)
 * - `--exclude <glob>`   - Skip .compact files matching pattern, in BOTH the
 *                          compiler's file discovery AND the builder's
 *                          .compact copy (repeatable). When unset, the builder
 *                          falls back to ['Mock*', '*.mock.compact']; the
 *                          compiler defaults to no excludes.
 * - `+<version>`         - Use specific toolchain version
 *
 * Builder-only options (control dist/ layout):
 * - `--clean-dist`       - rm -rf dist before building (default off)
 * - `--copy <path>`      - copy an extra file into dist/ for distribution (repeatable; e.g. package.json)
 *
 * See `packages/cli/README.md` for usage examples.
 */
async function runBuilder(): Promise<void> {
  const spinner = ora(chalk.blue('[BUILD] Compact Builder started')).info();

  try {
    const args = process.argv.slice(2);
    const builder = CompactBuilder.fromArgs(args);
    await builder.build();
  } catch (err) {
    spinner.fail(
      chalk.red('[BUILD] Unexpected error:', (err as Error).message),
    );
    process.exit(1);
  }
}

runBuilder();
