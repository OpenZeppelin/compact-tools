import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isMusl,
  type ReleasedBinary,
  resolveBinary,
  userCacheDir,
} from '@openzeppelin/compact-launcher';

export const COMPACT_LINT: ReleasedBinary = {
  name: 'compact-lint',
  packageName: 'compact-linter',
  overrideEnv: 'COMPACT_LINT_BINARY',
  downloadBaseEnv: 'COMPACT_LINT_DOWNLOAD_BASE',
};

// One level up from src/ and from dist/ alike, so both entry points find the manifest.
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

function packageVersion(): string {
  const manifest = readFileSync(join(packageDir, 'package.json'), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}

/**
 * Path to the `compact-lint` executable: `COMPACT_LINT_BINARY`, else the release asset
 * cached per user, downloaded and verified on first use.
 */
export function resolveLintBinary(): Promise<string> {
  return resolveBinary({
    binary: COMPACT_LINT,
    packageDir,
    cacheDir: userCacheDir(
      COMPACT_LINT.packageName,
      process.platform,
      process.env,
      homedir(),
    ),
    version: packageVersion(),
    platform: process.platform,
    arch: process.arch,
    musl: isMusl(),
    env: process.env,
    notify: (message) => process.stderr.write(`compact-linter: ${message}\n`),
  });
}
