/**
 * Compiles the committed fixture mocks with `--skip-zk`. Runs as Vitest's globalSetup and as
 * `yarn compile:fixtures`. It never runs compact-mock: `yarn types` needs the artifacts, and CI
 * builds the binary after it.
 */

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const SOURCES_DIR = join(dirname(__filename), 'fixtures', 'src');
const ARTIFACTS_DIR = join(dirname(__filename), 'fixtures', 'artifacts');

// Generated artifacts assert the runtime minor at load time, so the compiler must match the
// installed compact-runtime. COMPACTC_VERSION overrides it.
const COMPILER_VERSION = process.env.COMPACTC_VERSION ?? '0.36.0';

const SOURCES = readdirSync(SOURCES_DIR, { recursive: true, encoding: 'utf8' })
  .filter((path) => path.endsWith('.compact'))
  .map((path) => join(SOURCES_DIR, path));

const MOCKS = SOURCES.filter(
  (path) =>
    basename(dirname(path)) === 'mocks' && !path.endsWith('.fragment.compact'),
);

// A module or fragment edit leaves the mock's mtime alone, so freshness is against every source.
const NEWEST_SOURCE = Math.max(
  ...SOURCES.map((path) => statSync(path).mtimeMs),
);

async function compileMock(mockPath: string): Promise<void> {
  const name = basename(mockPath, '.compact');
  const outputDir = join(ARTIFACTS_DIR, name);
  const contractArtifact = join(outputDir, 'contract', 'index.js');
  const stampPath = join(outputDir, '.compiler-stamp');

  if (existsSync(contractArtifact)) {
    const fresh =
      statSync(contractArtifact).mtimeMs >= NEWEST_SOURCE &&
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
      mockPath,
      outputDir,
    ]);
  } catch (err: unknown) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') {
      throw new Error('`compact` not found. Is it installed and on PATH?');
    }
    throw err;
  }
  writeFileSync(stampPath, `${COMPILER_VERSION}\n`);
  console.log(`compiled ${name}`);
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  for (const mockPath of MOCKS) {
    await compileMock(mockPath);
  }
}

if (process.argv[1] === __filename) {
  await globalSetup();
}
