import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBinary, userCacheDir } from '@openzeppelin/compact-launcher';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPACT_PROFILE,
  packageDir,
  resolveProfileBinary,
} from '../src/launcher.ts';

const BIN = join(packageDir, 'src', 'compactProfile.ts');
const TARGETS = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
];

let install: string;

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), 'compact-profile-pkg-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(install, { recursive: true, force: true });
});

describe('COMPACT_PROFILE', () => {
  it('names the compact-profile crate and bin, the compact-profiler package, and their variables', () => {
    expect(COMPACT_PROFILE).toStrictEqual({
      name: 'compact-profile',
      packageName: 'compact-profiler',
      bin: 'compact-profile',
      overrideEnv: 'COMPACT_PROFILE_BINARY',
      downloadBaseEnv: 'COMPACT_PROFILE_DOWNLOAD_BASE',
    });
  });

  it('caches under compact-profiler', () => {
    const name = COMPACT_PROFILE.packageName;
    expect(userCacheDir(name, 'linux', { XDG_CACHE_HOME: '/xdg' }, '/h')).toBe(
      '/xdg/compact-profiler',
    );
    expect(userCacheDir(name, 'linux', {}, '/home/dev')).toBe(
      '/home/dev/.cache/compact-profiler',
    );
    expect(userCacheDir(name, 'darwin', {}, '/Users/dev')).toBe(
      '/Users/dev/Library/Caches/compact-profiler',
    );
  });

  it('downloads compact-profile-<target> from the compact-profiler release', async () => {
    writeFileSync(
      join(install, 'checksums.txt'),
      `${'0'.repeat(64)}  compact-profile-x86_64-unknown-linux-gnu\n`,
    );
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const notices: string[] = [];

    await expect(
      resolveBinary({
        binary: COMPACT_PROFILE,
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
      'download failed for https://github.com/OpenZeppelin/compact-tools/releases/download/compact-profiler/v0.1.0/compact-profile-x86_64-unknown-linux-gnu: offline',
    );
    expect(notices).toStrictEqual([
      'downloading compact-profile-x86_64-unknown-linux-gnu (v0.1.0)',
    ]);
  });
});

describe('resolveProfileBinary', () => {
  it('runs the binary cached for the installed version under the user cache', async () => {
    const version = (
      JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    const xdg = join(install, 'xdg');
    const cached = [
      join(xdg, 'compact-profiler'),
      join(install, 'Library', 'Caches', 'compact-profiler'),
    ].flatMap((dir) => {
      mkdirSync(dir, { recursive: true });
      return TARGETS.map((target) => {
        const path = join(dir, `compact-profile-${version}-${target}`);
        writeFileSync(path, '');
        return path;
      });
    });
    vi.stubEnv('HOME', install);
    vi.stubEnv('XDG_CACHE_HOME', xdg);
    vi.stubEnv('COMPACT_PROFILE_BINARY', undefined);

    expect(cached).toContain(await resolveProfileBinary());
  });
});

describe('the compact-profile bin', () => {
  it('runs COMPACT_PROFILE_BINARY on its arguments and passes on the exit code', () => {
    const stub = join(install, 'stub-profile');
    writeFileSync(stub, '#!/bin/sh\necho "args: $*"\nexit 7\n');
    chmodSync(stub, 0o755);

    const run = spawnSync(process.execPath, [BIN, 'check', '--strict', 'src'], {
      encoding: 'utf8',
      env: { ...process.env, COMPACT_PROFILE_BINARY: stub },
    });

    expect(run.stdout).toBe('args: check --strict src\n');
    expect(run.status).toBe(7);
  });

  it('exits 2 under the compact-profile prefix when the binary cannot be started', () => {
    const missing = join(install, 'not-installed');

    const run = spawnSync(process.execPath, [BIN, 'check'], {
      encoding: 'utf8',
      env: { ...process.env, COMPACT_PROFILE_BINARY: missing },
    });

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`compact-profile: cannot run ${missing}`);
  });
});
