#!/usr/bin/env node

/**
 * Test setup script that compiles sample contracts before running tests.
 * This ensures test artifacts are generated dynamically rather than being hardcoded.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SAMPLE_CONTRACTS_DIR = join(__dirname, 'fixtures', 'sample-contracts');
const ARTIFACTS_DIR = join(__dirname, 'fixtures', 'artifacts');

const CONTRACT_FILES = ['Simple.compact', 'Witness.compact', 'SampleZOwnable.compact'];

// Singleton pattern to ensure setup only runs once across all test workers
let setupPromise: Promise<void> | null = null;
let setupComplete = false;

async function compileContract(contractFile: string): Promise<void> {
  const inputPath = join(SAMPLE_CONTRACTS_DIR, contractFile);
  const contractName = contractFile.replace('.compact', '');
  const outputDir = join(ARTIFACTS_DIR, contractName);

  if (!existsSync(inputPath)) {
    throw new Error(`Contract file not found: ${inputPath}`);
  }

  // Ensure output directory and keys subdirectory exist
  // compact compile requires the keys directory to exist
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(outputDir, 'keys'), { recursive: true });

  try {
    const command = `compact compile --skip-zk "${inputPath}" "${outputDir}"`;
    const { stderr } = await execAsync(command);
    
    if (stderr && !stderr.includes('warning')) {
      console.log(`Warning for ${contractFile}: ${stderr}`);
    }
    console.log(`✓ Compiled ${contractFile}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to compile ${contractFile}: ${message}`);
  }
}

async function setup(): Promise<void> {
  // If setup is already complete, return immediately
  if (setupComplete) {
    return;
  }

  // If setup is in progress, wait for it
  if (setupPromise) {
    return setupPromise;
  }

  // Start setup
  setupPromise = (async () => {
    console.log('🔨 Compiling sample contracts for tests...\n');

    // Ensure artifacts directory exists
    mkdirSync(ARTIFACTS_DIR, { recursive: true });

    // Compile each contract
    for (const contractFile of CONTRACT_FILES) {
      await compileContract(contractFile);
    }

    console.log('\n✅ Test artifacts compiled successfully!\n');
    setupComplete = true;
  })();

  try {
    await setupPromise;
  } catch (error) {
    // Reset promise on error so it can be retried
    setupPromise = null;
    throw error;
  }
}

// Always run setup when this file is loaded by vitest
// Vitest's `setupFiles` loads (imports) this module, so execute on import.
// The singleton pattern ensures it only runs once even with parallel workers.
await setup().catch((error) => {
  console.log(`❌ Setup failed: ${error}`);
  process.exit(1);
});

// Export default function as well (useful if needed elsewhere)
export default setup;

