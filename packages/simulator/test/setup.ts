/**
 * Test setup script that compiles sample contracts before running tests.
 * Runs once before all tests via Vitest's globalSetup.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SAMPLE_CONTRACTS_DIR = join(__dirname, 'fixtures', 'sample-contracts');
const ARTIFACTS_DIR = join(__dirname, 'fixtures', 'artifacts');

const CONTRACT_FILES = [
  'Simple.compact',
  'Witness.compact',
  'SampleZOwnable.compact',
  'Ecdsa.compact',
];

async function compileContract(contractFile: string): Promise<void> {
  const inputPath = join(SAMPLE_CONTRACTS_DIR, contractFile);
  const contractName = contractFile.replace('.compact', '');
  const outputDir = join(ARTIFACTS_DIR, contractName);
  const contractArtifact = join(outputDir, 'contract', 'index.js');

  // Skip if artifact already exists and is newer than source
  if (existsSync(contractArtifact) && existsSync(inputPath)) {
    const artifactTime = statSync(contractArtifact).mtime;
    const sourceTime = statSync(inputPath).mtime;
    if (artifactTime >= sourceTime) {
      console.log(`✓ ${contractFile} (already compiled)`);
      return; // Already compiled and up to date
    }
  }

  if (!existsSync(inputPath)) {
    throw new Error(`Contract file not found: ${inputPath}`);
  }

  // Ensure output directory and keys subdirectory exist
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(outputDir, 'keys'), { recursive: true });

  // Pin the compiler to the ECDSA/0.18-runtime toolchain. The default toolchain
  // (compactc 0.31.x) emits code expecting compact-runtime 0.16.0, which the
  // 0.18.0-rc.1 runtime this package now depends on rejects at load time.
  // Override via COMPACTC_VERSION if a newer pinned toolchain is installed.
  const compilerVersion = process.env.COMPACTC_VERSION ?? '0.33.0-rc.2';
  // secp256k1 primitives (e.g. secp256k1EcdsaVerify) exist only in the ZKIR v3
  // backend, so contracts that use them must opt in; others stay on the default.
  const usesSecp256k1 = /secp256k1/i.test(readFileSync(inputPath, 'utf8'));

  // execFile (no shell) with an argument array: the compiler version and paths
  // are passed as discrete args, never interpolated into a command string, so
  // none of them can inject shell.
  const args = [
    'compile',
    `+${compilerVersion}`,
    ...(usesSecp256k1 ? ['--feature-zkir-v3'] : []),
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

  console.log(`✓ Compiled ${contractFile}`);
}

async function setup(): Promise<void> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  // Compile each contract sequentially
  for (const contractFile of CONTRACT_FILES) {
    await compileContract(contractFile);
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
