#!/usr/bin/env node

import { CompactBuilder } from '@openzeppelin/compact-builder';
import chalk from 'chalk';
import ora from 'ora';

/** `compact-builder` CLI shell. See `packages/cli/README.md` for options. */
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
