#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { resolveLintBinary } from './launcher.ts';

function fail(message: string): never {
  process.stderr.write(`compact-linter: ${message}
`);
  process.exit(2);
}

async function runLint(): Promise<void> {
  let binary: string;
  try {
    binary = await resolveLintBinary();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // argv0 keeps the cache file name out of the linter's own usage output.
  const result = spawnSync(binary, process.argv.slice(2), {
    argv0: 'compact-linter',
    stdio: 'inherit',
  });
  if (result.error) {
    fail(`cannot run ${binary}: ${result.error.message}`);
  }
  if (result.signal) {
    process.exit(128 + (constants.signals[result.signal] ?? 0));
  }
  process.exit(result.status ?? 0);
}

await runLint();
