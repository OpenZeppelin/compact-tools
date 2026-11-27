import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET_DIR = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  '..',
  '..',
  'target',
);

/** The binary `cargo build -p compact-mock --release` writes in this repository. */
export const RELEASE_BINARY = join(TARGET_DIR, 'release', 'compact-mock');

/** The binary `cargo build -p compact-mock` writes in this repository. */
export const DEBUG_BINARY = join(TARGET_DIR, 'debug', 'compact-mock');

/**
 * The `compact-mock` the end-to-end tests run: `COMPACT_MOCK_BINARY`, else the local release
 * build, else the local debug build. Without one the tests skip locally and fail under `CI`,
 * so CI cannot pass without building the fixture mocks.
 */
export function binaryUnderTest(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): { binary: string; skip?: string } {
  const candidates = env.COMPACT_MOCK_BINARY
    ? [env.COMPACT_MOCK_BINARY]
    : [RELEASE_BINARY, DEBUG_BINARY];
  const binary = candidates.find(exists);
  if (binary !== undefined) {
    return { binary };
  }
  const reason = `no binary at ${candidates.join(' or ')}; build crates/compact-mock or set COMPACT_MOCK_BINARY`;
  if (env.CI) {
    throw new Error(reason);
  }
  return { binary: candidates[0], skip: reason };
}
