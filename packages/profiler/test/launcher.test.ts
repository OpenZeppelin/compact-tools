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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ResolveOptions,
  resolveBinary,
  userCacheDir,
} from '@openzeppelin/compact-launcher';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPACT_PROFILE, resolveProfileBinary } from '../src/launcher.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGETS = [
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
];

let install: string;
let notices: string[];

function options(overrides: Partial<ResolveOptions> = {}): ResolveOptions {
  return {
    binary: COMPACT_PROFILE,
    packageDir: install,
    cacheDir: join(install, 'cache'),
    version: '0.1.0',
    platform: 'linux',
    arch: 'x64',
    musl: false,
    env: {},
    notify: (message) => notices.push(message),
    ...overrides,
  };
}

/** A `checksums.txt` entry for the asset, so a download gets as far as the fetch. */
function packageChecksums(): void {
  writeFileSync(
    join(install, 'checksums.txt'),
    `${'0'.repeat(64)}  compact-profile-x86_64-unknown-linux-gnu\n`,
  );
}

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), 'compact-profile-pkg-'));
  notices = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(install, { recursive: true, force: true });
});

describe('COMPACT_PROFILE', () => {
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

  it('names the compact-profile crate and COMPACT_PROFILE_BINARY when no prebuilt binary fits', async () => {
    await expect(
      resolveBinary(options({ platform: 'win32', arch: 'x64' })),
    ).rejects.toThrow(
      'no prebuilt binary for win32-x64; build from source with cargo (crates/compact-profile) and set COMPACT_PROFILE_BINARY',
    );
    await expect(resolveBinary(options({ musl: true }))).rejects.toThrow(
      'no prebuilt binary for musl Linux, the release binaries need glibc; build from source with cargo (crates/compact-profile) and set COMPACT_PROFILE_BINARY',
    );
  });

  it('runs COMPACT_PROFILE_BINARY on a musl host', async () => {
    const binary = await resolveBinary(
      options({
        musl: true,
        env: { COMPACT_PROFILE_BINARY: '/opt/compact-profile' },
      }),
    );
    expect(binary).toBe('/opt/compact-profile');
  });

  it('serves compact-profile-<version>-<target> from the cache', async () => {
    const cached = join(
      install,
      'cache',
      'compact-profile-0.1.0-x86_64-unknown-linux-gnu',
    );
    mkdirSync(dirname(cached));
    writeFileSync(cached, '');
    expect(await resolveBinary(options())).toBe(cached);
    expect(notices).toStrictEqual([]);
  });

  it('downloads compact-profile-<target> from the compact-profiler release', async () => {
    packageChecksums();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(resolveBinary(options())).rejects.toThrow(
      'download failed for https://github.com/OpenZeppelin/compact-tools/releases/download/compact-profiler/v0.1.0/compact-profile-x86_64-unknown-linux-gnu: offline',
    );
    expect(notices).toStrictEqual([
      'downloading compact-profile-x86_64-unknown-linux-gnu (v0.1.0)',
    ]);
  });

  it('downloads from COMPACT_PROFILE_DOWNLOAD_BASE', async () => {
    packageChecksums();
    await expect(
      resolveBinary(
        options({
          env: { COMPACT_PROFILE_DOWNLOAD_BASE: 'http://127.0.0.1:1/download' },
        }),
      ),
    ).rejects.toThrow(
      'download failed for http://127.0.0.1:1/download/compact-profile-x86_64-unknown-linux-gnu',
    );
  });

  it('asks for COMPACT_PROFILE_BINARY when the package checksums are missing', async () => {
    await expect(resolveBinary(options())).rejects.toThrow(
      `${join(install, 'checksums.txt')} is missing, so a download cannot be verified; set COMPACT_PROFILE_BINARY`,
    );
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
  it('passes its arguments to the binary and forwards the exit code', () => {
    const stub = join(install, 'stub-profile');
    writeFileSync(stub, '#!/bin/sh\necho "args: $*"\nexit 7\n');
    chmodSync(stub, 0o755);

    const run = spawnSync(
      process.execPath,
      [
        join(packageDir, 'src', 'compactProfile.ts'),
        'check',
        '--strict',
        'src',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, COMPACT_PROFILE_BINARY: stub },
      },
    );

    expect(run.stdout).toBe('args: check --strict src\n');
    expect(run.status).toBe(7);
  });

  it('exits 2 when no binary can be resolved', () => {
    const run = spawnSync(
      process.execPath,
      [join(packageDir, 'src', 'compactProfile.ts'), 'check'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          COMPACT_PROFILE_BINARY: join(install, 'not-installed'),
        },
      },
    );

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('compact-profile: cannot run');
  });
});
