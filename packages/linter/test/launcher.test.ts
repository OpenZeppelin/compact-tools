import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hostOptions,
  resolveBinary,
  userCacheDir,
} from '@openzeppelin/compact-launcher';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPACT_LINT, packageDir } from '../src/launcher.ts';

const BIN = join(packageDir, 'src', 'compactLinter.ts');

let install: string;

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), 'compact-lint-pkg-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(install, { recursive: true, force: true });
});

describe('COMPACT_LINT', () => {
  it('names the compact-lint crate, the compact-linter package and bin, and their variables', () => {
    expect(COMPACT_LINT).toStrictEqual({
      name: 'compact-lint',
      packageName: 'compact-linter',
      bin: 'compact-linter',
      overrideEnv: 'COMPACT_LINT_BINARY',
      downloadBaseEnv: 'COMPACT_LINT_DOWNLOAD_BASE',
    });
  });

  it('caches under compact-linter', () => {
    const name = COMPACT_LINT.packageName;
    expect(userCacheDir(name, 'linux', { XDG_CACHE_HOME: '/xdg' }, '/h')).toBe(
      '/xdg/compact-linter',
    );
    expect(userCacheDir(name, 'linux', {}, '/home/dev')).toBe(
      '/home/dev/.cache/compact-linter',
    );
    expect(userCacheDir(name, 'darwin', {}, '/Users/dev')).toBe(
      '/Users/dev/Library/Caches/compact-linter',
    );
  });

  it('downloads compact-lint-<target> from the compact-linter release', async () => {
    writeFileSync(
      join(install, 'checksums.txt'),
      `${'0'.repeat(64)}  compact-lint-x86_64-unknown-linux-gnu\n`,
    );
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const notices: string[] = [];

    await expect(
      resolveBinary({
        binary: COMPACT_LINT,
        packageDir: install,
        cacheDir: join(install, 'cache'),
        version: '0.1.0',
        platform: 'linux',
        arch: 'x64',
        musl: false,
        env: {},
        notify: (message) => notices.push(message),
      }),
    ).rejects.toThrow(
      'download failed for https://github.com/OpenZeppelin/compact-tools/releases/download/compact-linter/v0.1.0/compact-lint-x86_64-unknown-linux-gnu: offline',
    );
    expect(notices).toStrictEqual([
      'downloading compact-lint-x86_64-unknown-linux-gnu (v0.1.0)',
    ]);
  });
});

describe('packageDir', () => {
  it('resolves at the version of the installed compact-linter', () => {
    const manifest = JSON.parse(
      readFileSync(join(packageDir, 'package.json'), 'utf8'),
    );

    expect(manifest.name).toBe('@openzeppelin/compact-linter');
    expect(hostOptions(COMPACT_LINT, packageDir).version).toBe(
      manifest.version,
    );
  });
});

describe('the compact-linter bin', () => {
  it('runs COMPACT_LINT_BINARY on its arguments and passes on the exit code', () => {
    const stub = join(install, 'stub-lint');
    writeFileSync(stub, '#!/bin/sh\necho "args: $*"\nexit 7\n');
    chmodSync(stub, 0o755);

    const run = spawnSync(process.execPath, [BIN, 'check', '--strict', 'src'], {
      encoding: 'utf8',
      env: { ...process.env, COMPACT_LINT_BINARY: stub },
    });

    expect(run.stdout).toBe('args: check --strict src\n');
    expect(run.status).toBe(7);
  });

  it('exits 2 under the compact-linter prefix when the binary cannot be started', () => {
    const missing = join(install, 'not-installed');

    const run = spawnSync(process.execPath, [BIN, 'check'], {
      encoding: 'utf8',
      env: { ...process.env, COMPACT_LINT_BINARY: missing },
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`compact-linter: cannot run ${missing}`);
  });
});
