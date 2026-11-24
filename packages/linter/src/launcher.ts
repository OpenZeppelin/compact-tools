import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleasedBinary } from '@openzeppelin/compact-launcher';

export const COMPACT_LINT: ReleasedBinary = {
  name: 'compact-lint',
  packageName: 'compact-linter',
  bin: 'compact-linter',
  overrideEnv: 'COMPACT_LINT_BINARY',
  downloadBaseEnv: 'COMPACT_LINT_DOWNLOAD_BASE',
};

// One level up from src/ and from dist/ alike, so both entry points find the manifest.
export const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
