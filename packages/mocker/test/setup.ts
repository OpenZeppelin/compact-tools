/**
 * Builds the fixture mocks with the compact-mock under test: `build +0.36.0 --skip-zk` over
 * `fixtures/compact.toml`, which writes them to the ignored `src/<dir>/test/artifacts/`. Runs as
 * Vitest's globalSetup and as `yarn compile:fixtures`.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { binaryUnderTest } from './binaryUnderTest.ts';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
export const FIXTURES = join(dirname(__filename), 'fixtures');
export const CONFIG = join(FIXTURES, 'compact.toml');

// Generated artifacts assert the runtime minor at load time, so the compiler must match the
// installed compact-runtime. COMPACTC_VERSION overrides it.
export const COMPILER_VERSION = process.env.COMPACTC_VERSION ?? '0.36.0';

async function buildFixtures(binary: string): Promise<void> {
  try {
    const { stderr } = await execFileAsync(
      binary,
      ['build', `+${COMPILER_VERSION}`, '--skip-zk', '--config', CONFIG],
      { cwd: FIXTURES, maxBuffer: 64 * 1024 * 1024 },
    );
    process.stderr.write(stderr);
  } catch (err: unknown) {
    const failure = err as { stdout?: string; stderr?: string } | null;
    throw new Error(
      `${binary} build failed\n${failure?.stdout ?? ''}${failure?.stderr ?? ''}`,
      { cause: err },
    );
  }
}

/** Skips locally without a binary, so the specs that need the mocks skip too. */
export default async function globalSetup(): Promise<void> {
  const { binary, skip } = binaryUnderTest(process.env, existsSync);
  if (skip !== undefined) {
    process.stderr.write(`fixture mocks not built: ${skip}\n`);
    return;
  }
  await buildFixtures(binary);
}

// `yarn types` type-checks the specs against the built mocks, so the script never skips.
if (process.argv[1] === __filename) {
  const { binary, skip } = binaryUnderTest(process.env, existsSync);
  if (skip !== undefined) {
    throw new Error(skip);
  }
  await buildFixtures(binary);
}
