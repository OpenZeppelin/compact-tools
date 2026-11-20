#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { resolveProfileBinary } from './launcher.ts';

function fail(message: string): never {
  process.stderr.write(`compact-profile: ${message}\n`);
  process.exit(2);
}

async function runProfile(): Promise<void> {
  let binary: string;
  try {
    binary = await resolveProfileBinary();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // argv0 keeps the cache file name out of the binary's own usage output.
  const result = spawnSync(binary, process.argv.slice(2), {
    argv0: 'compact-profile',
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

await runProfile();
