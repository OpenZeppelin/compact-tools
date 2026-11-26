import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The binary `cargo build -p compact-mock --release` writes in this repository. */
export const BUILT_BINARY = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  '..',
  '..',
  'target',
  'release',
  'compact-mock',
);

/**
 * The `compact-mock` the end-to-end tests run: `COMPACT_MOCK_BINARY`, else the local
 * release build. Without one the tests skip locally and fail under `CI`, so CI cannot pass
 * without the drift check.
 */
export function binaryUnderTest(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): { binary: string; skip?: string } {
  const binary = env.COMPACT_MOCK_BINARY || BUILT_BINARY;
  if (exists(binary)) {
    return { binary };
  }
  const reason = `no binary at ${binary}; build crates/compact-mock or set COMPACT_MOCK_BINARY`;
  if (env.CI) {
    throw new Error(reason);
  }
  return { binary, skip: reason };
}
