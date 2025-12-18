/**
 * Test setup script that compiles sample contracts before running tests.
 * Runs once before all tests via Vitest's globalSetup.
 */

import { exec } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SAMPLE_CONTRACTS_DIR = join(__dirname, 'fixtures', 'sample-contracts');
const ARTIFACTS_DIR = join(__dirname, 'fixtures', 'artifacts');

// TODO: Remove version pin once 0.27.0 is released
const COMPILER_VERSION = '0.27.0-rc.1';

const CONTRACT_FILES = [
  'Simple.compact',
  'Witness.compact',
  'SampleZOwnable.compact',
];

async function compileContract(contractFile: string): Promise<void> {
  const inputPath = join(SAMPLE_CONTRACTS_DIR, contractFile);
  const contractName = contractFile.replace('.compact', '');
  const outputDir = join(ARTIFACTS_DIR, contractName);
  const contractArtifact = join(outputDir, 'contract', 'index.cjs');

  // Skip if artifact already exists and is newer than source
  if (existsSync(contractArtifact) && existsSync(inputPath)) {
    const artifactTime = statSync(contractArtifact).mtime;
    const sourceTime = statSync(inputPath).mtime;
    if (artifactTime >= sourceTime) {
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

  // const command = `compact compile --skip-zk "${inputPath}" "${outputDir}"`;
  const command = `compact compile +${COMPILER_VERSION} --skip-zk "${inputPath}" "${outputDir}"`;

  try {
    await execAsync(command);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 127) {
      throw new Error(
        `\`compact\` compiler version ${COMPILER_VERSION} not found. Is it installed?`,
      );
    }
    throw err;
  }

  console.log(`✓ Compiled ${contractFile}`);
}

async function setup(): Promise<void> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  for (const contractFile of CONTRACT_FILES) {
    await compileContract(contractFile);
  }
}

export default async function globalSetup(): Promise<void> {
  try {
    await setup();
  } catch (error) {
    console.log(`❌ Setup failed: ${error}`);
    process.exit(1);
  }
}
