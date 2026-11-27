import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
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
import { COMPACT_MOCK, packageDir } from '../src/launcher.ts';

const BIN = join(packageDir, 'src', 'compactMock.ts');
const TARGETS = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
];

let install: string;

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), 'compact-mock-pkg-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(install, { recursive: true, force: true });
});

describe('COMPACT_MOCK', () => {
  it('names the compact-mock crate and bin, the compact-mocker package, and their variables', () => {
    expect(COMPACT_MOCK).toStrictEqual({
      name: 'compact-mock',
      packageName: 'compact-mocker',
      bin: 'compact-mock',
      overrideEnv: 'COMPACT_MOCK_BINARY',
      downloadBaseEnv: 'COMPACT_MOCK_DOWNLOAD_BASE',
    });
  });

  it('caches under compact-mocker', () => {
    const name = COMPACT_MOCK.packageName;
    expect(userCacheDir(name, 'linux', { XDG_CACHE_HOME: '/xdg' }, '/h')).toBe(
      '/xdg/compact-mocker',
    );
    expect(userCacheDir(name, 'linux', {}, '/home/dev')).toBe(
      '/home/dev/.cache/compact-mocker',
    );
    expect(userCacheDir(name, 'darwin', {}, '/Users/dev')).toBe(
      '/Users/dev/Library/Caches/compact-mocker',
    );
  });

  it('downloads compact-mock-<target> from the compact-mocker release', async () => {
    writeFileSync(
      join(install, 'checksums.txt'),
      `${'0'.repeat(64)}  compact-mock-x86_64-unknown-linux-gnu\n`,
    );
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const notices: string[] = [];

    await expect(
      resolveBinary({
        binary: COMPACT_MOCK,
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
      'download failed for https://github.com/OpenZeppelin/compact-tools/releases/download/compact-mocker/v0.1.0/compact-mock-x86_64-unknown-linux-gnu: offline',
    );
    expect(notices).toStrictEqual([
      'downloading compact-mock-x86_64-unknown-linux-gnu (v0.1.0)',
    ]);
  });
});

describe('packageDir', () => {
  it('resolves at the version of the installed compact-mocker', () => {
    const manifest = JSON.parse(
      readFileSync(join(packageDir, 'package.json'), 'utf8'),
    );

    expect(manifest.name).toBe('@openzeppelin/compact-mocker');
    expect(hostOptions(COMPACT_MOCK, packageDir).version).toBe(
      manifest.version,
    );
  });
});

describe('the compact-mock bin', () => {
  it('runs COMPACT_MOCK_BINARY on its arguments and passes on the exit code', () => {
    const stub = join(install, 'stub-mock');
    writeFileSync(stub, '#!/bin/sh\necho "args: $*"\nexit 7\n');
    chmodSync(stub, 0o755);

    const run = spawnSync(
      process.execPath,
      [BIN, 'generate', '--check', '--config', 'compact-mock.toml'],
      {
        encoding: 'utf8',
        env: { ...process.env, COMPACT_MOCK_BINARY: stub },
      },
    );

    expect(run.stdout).toBe(
      'args: generate --check --config compact-mock.toml\n',
    );
    expect(run.status).toBe(7);
  });

  it('exits 2 without running a cached binary it cannot verify', () => {
    const { version } = JSON.parse(
      readFileSync(join(packageDir, 'package.json'), 'utf8'),
    ) as { version: string };
    const ran = join(install, 'ran');
    const xdg = join(install, 'xdg');
    for (const dir of [
      join(xdg, 'compact-mocker'),
      join(install, 'Library', 'Caches', 'compact-mocker'),
    ]) {
      mkdirSync(dir, { recursive: true });
      for (const target of TARGETS) {
        writeFileSync(
          join(dir, `compact-mock-${version}-${target}`),
          `#!/bin/sh\ntouch ${ran}\n`,
          { mode: 0o755 },
        );
      }
    }
    const { COMPACT_MOCK_BINARY: _, ...env } = process.env;

    const run = spawnSync(process.execPath, [BIN, 'generate'], {
      encoding: 'utf8',
      env: { ...env, HOME: install, XDG_CACHE_HOME: xdg },
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toBe(
      `compact-mock: ${join(packageDir, 'checksums.txt')} is missing, so the binary cannot be verified; set COMPACT_MOCK_BINARY\n`,
    );
    expect(existsSync(ran)).toBe(false);
  });

  it('exits 2 under the compact-mock prefix when the binary cannot be started', () => {
    const missing = join(install, 'not-installed');

    const run = spawnSync(process.execPath, [BIN, 'generate'], {
      encoding: 'utf8',
      env: { ...process.env, COMPACT_MOCK_BINARY: missing },
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`compact-mock: cannot run ${missing}`);
  });
});
