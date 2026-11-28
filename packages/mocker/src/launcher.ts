import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleasedBinary } from '@openzeppelin/compact-launcher';

export const COMPACT_MOCK: ReleasedBinary = {
  name: 'compact-mock',
  packageName: 'compact-mocker',
  bin: 'compact-mock',
  overrideEnv: 'COMPACT_MOCK_BINARY',
  downloadBaseEnv: 'COMPACT_MOCK_DOWNLOAD_BASE',
};

// One level up from src/ and from dist/ alike, so both entry points find the manifest.
export const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
