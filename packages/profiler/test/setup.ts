/**
 * Compiles the fixture contracts with `--skip-zk`. Runs as Vitest's globalSetup and as
 * `yarn compile:fixtures`.
 */

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const SAMPLE_CONTRACTS_DIR = join(
  dirname(__filename),
  'fixtures',
  'sample-contracts',
);
const ARTIFACTS_DIR = join(dirname(__filename), 'fixtures', 'artifacts');

const CONTRACT_FILES: readonly string[] = ['Counter.compact', 'Mint.compact'];

// Generated artifacts assert the runtime minor at load time, so the compiler must match the
// installed compact-runtime. COMPACTC_VERSION overrides it.
const COMPILER_VERSION = process.env.COMPACTC_VERSION ?? '0.36.0';

async function compileContract(contractFile: string): Promise<void> {
  const inputPath = join(SAMPLE_CONTRACTS_DIR, contractFile);
  const outputDir = join(ARTIFACTS_DIR, contractFile.replace('.compact', ''));
  const contractArtifact = join(outputDir, 'contract', 'index.js');
  const stampPath = join(outputDir, '.compiler-stamp');

  // Reuse an artifact only when it is newer than its source and this toolchain built it.
  if (existsSync(contractArtifact)) {
    const fresh =
      statSync(contractArtifact).mtime >= statSync(inputPath).mtime &&
      existsSync(stampPath) &&
      readFileSync(stampPath, 'utf8').trim() === COMPILER_VERSION;
    if (fresh) {
      return;
    }
  }

  mkdirSync(outputDir, { recursive: true });
  try {
    await execFileAsync('compact', [
      'compile',
      `+${COMPILER_VERSION}`,
      '--skip-zk',
      inputPath,
      outputDir,
    ]);
  } catch (err: unknown) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') {
      throw new Error('`compact` not found. Is it installed and on PATH?');
    }
    throw err;
  }
  writeFileSync(stampPath, `${COMPILER_VERSION}\n`);
  console.log(`compiled ${contractFile}`);
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  for (const contractFile of CONTRACT_FILES) {
    await compileContract(contractFile);
  }
}

if (process.argv[1] === __filename) {
  await globalSetup();
}
