import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The binary `cargo build -p compact-profile --release` writes in this repository. */
export const BUILT_BINARY = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  '..',
  '..',
  'target',
  'release',
  'compact-profile',
);

/**
 * The `compact-profile` the end-to-end tests run: `COMPACT_PROFILE_BINARY`, else the local
 * release build. Without one the tests skip locally and fail under `CI`, so CI cannot pass
 * without checking parity.
 */
export function binaryUnderTest(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): { binary: string; skip?: string } {
  const binary = env.COMPACT_PROFILE_BINARY || BUILT_BINARY;
  if (exists(binary)) {
    return { binary };
  }
  const reason = `no binary at ${binary}; build crates/compact-profile or set COMPACT_PROFILE_BINARY`;
  if (env.CI) {
    throw new Error(reason);
  }
  return { binary, skip: reason };
}
