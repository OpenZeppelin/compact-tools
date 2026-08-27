/**
 * Test setup script that compiles sample contracts before running tests.
 * Runs once before all tests via Vitest's globalSetup.
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
const __dirname = dirname(__filename);

const SAMPLE_CONTRACTS_DIR = join(__dirname, 'fixtures', 'sample-contracts');
const ARTIFACTS_DIR = join(__dirname, 'fixtures', 'artifacts');

/**
 * The fixtures to compile. `zkirV3` opts a fixture into the ZKIR v3 backend,
 * the only one carrying the secp256k1 primitives.
 */
const CONTRACT_FILES: readonly { file: string; zkirV3?: boolean }[] = [
  { file: 'Simple.compact' },
  { file: 'Witness.compact' },
  { file: 'SampleZOwnable.compact' },
  { file: 'Ecdsa.compact', zkirV3: true },
];

// Pin the compiler to the ECDSA/0.18-runtime toolchain. The default toolchain
// (compactc 0.31.x) emits code expecting compact-runtime 0.16.0, which the
// 0.18.0-rc.1 runtime this package now depends on rejects at load time.
// Override via COMPACTC_VERSION if a newer pinned toolchain is installed.
const COMPILER_VERSION = process.env.COMPACTC_VERSION ?? '0.33.0-rc.2';

/** Identifies what an artifact was built with, so a change forces a rebuild. */
const stampFor = (zkirV3: boolean): string =>
  `${COMPILER_VERSION}${zkirV3 ? '+zkir-v3' : ''}`;

async function compileContract(contract: {
  file: string;
  zkirV3?: boolean;
}): Promise<void> {
  const { file: contractFile, zkirV3 = false } = contract;
  const inputPath = join(SAMPLE_CONTRACTS_DIR, contractFile);
  const contractName = contractFile.replace('.compact', '');
  const outputDir = join(ARTIFACTS_DIR, contractName);
  const contractArtifact = join(outputDir, 'contract', 'index.js');
  const stampPath = join(outputDir, '.compiler-stamp');
  const stamp = stampFor(zkirV3);

  // Skip only if the artifact is newer than the source AND was built by this
  // toolchain. Without the stamp, an existing clone keeps artifacts the current
  // runtime rejects at load time.
  if (existsSync(contractArtifact) && existsSync(inputPath)) {
    const artifactTime = statSync(contractArtifact).mtime;
    const sourceTime = statSync(inputPath).mtime;
    const stampMatches =
      existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === stamp;
    if (artifactTime >= sourceTime && stampMatches) {
      console.log(`✓ ${contractFile} (already compiled)`);
      return;
    }
  }

  if (!existsSync(inputPath)) {
    throw new Error(`Contract file not found: ${inputPath}`);
  }

  // Ensure output directory and keys subdirectory exist
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(outputDir, 'keys'), { recursive: true });

  // execFile (no shell) with an argument array: the compiler version and paths
  // are passed as discrete args, never interpolated into a command string, so
  // none of them can inject shell.
  const args = [
    'compile',
    `+${COMPILER_VERSION}`,
    ...(zkirV3 ? ['--feature-zkir-v3'] : []),
    '--skip-zk',
    inputPath,
    outputDir,
  ];
  try {
    await execFileAsync('compact', args);
  } catch (err: unknown) {
    // Without a shell, a missing `compact` binary surfaces as ENOENT.
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') {
      throw new Error('`compact` not found. Is it installed and on PATH?');
    }
    throw err;
  }

  writeFileSync(stampPath, `${stamp}\n`);
  console.log(`✓ Compiled ${contractFile}`);
}

async function setup(): Promise<void> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  // Compile each contract sequentially
  for (const contract of CONTRACT_FILES) {
    await compileContract(contract);
  }
}

// Export setup function for Vitest's globalSetup
export default async function globalSetup(): Promise<void> {
  try {
    await setup();
  } catch (error) {
    console.log(`❌ Setup failed: ${error}`);
    process.exit(1);
  }
}

// Also runnable directly (`yarn compile:fixtures`), so the type check can
// depend on the artifacts without going through vitest.
if (process.argv[1] === __filename) {
  await globalSetup();
}
