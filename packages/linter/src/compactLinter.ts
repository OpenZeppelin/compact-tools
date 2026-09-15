#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBinary } from './binary.ts';

// One level up from src/ and from dist/ alike, so both entry points find the manifest.
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

function packageVersion(): string {
  const manifest = readFileSync(join(packageDir, 'package.json'), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}

function fail(message: string): never {
  process.stderr.write(`compact-linter: ${message}
`);
  process.exit(2);
}

async function runLint(): Promise<void> {
  let binary: string;
  try {
    binary = await resolveBinary({
      packageDir,
      version: packageVersion(),
      platform: process.platform,
      arch: process.arch,
      env: process.env,
      notify: (message) =>
        process.stderr.write(`compact-linter: ${message}
`),
    });
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
