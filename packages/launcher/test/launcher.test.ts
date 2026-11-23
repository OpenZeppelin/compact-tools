import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isMusl,
  type ReleasedBinary,
  type ResolveOptions,
  resolveBinary,
  userCacheDir,
} from '../src/launcher.ts';
import {
  expectedChecksum,
  parseChecksums,
  resolveTarget,
  sha256,
} from '../src/release.ts';

const FAKE_TOOL: ReleasedBinary = {
  name: 'fake-tool',
  packageName: 'fake-tools',
  overrideEnv: 'FAKE_TOOL_BINARY',
  downloadBaseEnv: 'FAKE_TOOL_DOWNLOAD_BASE',
};
const FAKE_BINARY = '#!/bin/sh\necho fake-tool "$@"\n';
const ASSET = 'fake-tool-x86_64-unknown-linux-gnu';

interface Origin {
  base: string;
  requests: string[];
  close: () => Promise<void>;
}

/** A release-shaped origin: one asset, one `checksums.txt`, every request path recorded. */
async function startOrigin(files: Record<string, string>): Promise<Origin> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').slice(1);
    requests.push(path);
    const body = files[path];
    if (body === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function checksumsFor(asset: string, body: string): string {
  const digest = createHash('sha256').update(body).digest('hex');
  return [
    `${'0'.repeat(64)}  fake-tool-aarch64-apple-darwin`,
    `${digest}  ${asset}`,
    `${'1'.repeat(64)}  fake-tool-aarch64-unknown-linux-gnu`,
  ].join('\n');
}

let install: string;
let notices: string[];

/** The `checksums.txt` the installed package was published with. */
function packageChecksums(body: string): void {
  writeFileSync(join(install, 'checksums.txt'), checksumsFor(ASSET, body));
}

function options(overrides: Partial<ResolveOptions> = {}): ResolveOptions {
  return {
    binary: FAKE_TOOL,
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

/** Runs `check` with `process.platform` reading `platform`. */
function onPlatform(platform: string, check: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    check();
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    }
  }
}

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), 'compact-launcher-pkg-'));
  notices = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(install, { recursive: true, force: true });
});

describe('resolveTarget', () => {
  it('maps every supported platform and architecture to its rust target', () => {
    expect(resolveTarget('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
    expect(resolveTarget('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
    expect(resolveTarget('darwin', 'x64')).toBe('x86_64-apple-darwin');
    expect(resolveTarget('darwin', 'arm64')).toBe('aarch64-apple-darwin');
  });

  it('returns null for a platform with no release asset', () => {
    expect(resolveTarget('win32', 'x64')).toBeNull();
    expect(resolveTarget('linux', 'ia32')).toBeNull();
  });
});

describe('userCacheDir', () => {
  it('uses XDG_CACHE_HOME on linux when it is absolute', () => {
    expect(
      userCacheDir(
        'fake-tools',
        'linux',
        { XDG_CACHE_HOME: '/xdg' },
        '/home/dev',
      ),
    ).toBe('/xdg/fake-tools');
  });

  it('falls back to ~/.cache on linux', () => {
    expect(userCacheDir('fake-tools', 'linux', {}, '/home/dev')).toBe(
      '/home/dev/.cache/fake-tools',
    );
    expect(
      userCacheDir(
        'fake-tools',
        'linux',
        { XDG_CACHE_HOME: 'relative' },
        '/home/dev',
      ),
    ).toBe('/home/dev/.cache/fake-tools');
  });

  it('uses ~/Library/Caches on macos', () => {
    expect(
      userCacheDir(
        'fake-tools',
        'darwin',
        { XDG_CACHE_HOME: '/xdg' },
        '/Users/dev',
      ),
    ).toBe('/Users/dev/Library/Caches/fake-tools');
  });
});

describe('isMusl', () => {
  it('is true on linux when the report names no glibc version', () => {
    vi.spyOn(process.report, 'getReport').mockReturnValue({ header: {} });
    onPlatform('linux', () => expect(isMusl()).toBe(true));
  });

  it('is false on linux when the report names a glibc version', () => {
    vi.spyOn(process.report, 'getReport').mockReturnValue({
      header: { glibcVersionRuntime: '2.39' },
    });
    onPlatform('linux', () => expect(isMusl()).toBe(false));
  });

  it('is false off linux without reading the report', () => {
    const getReport = vi.spyOn(process.report, 'getReport');
    onPlatform('darwin', () => expect(isMusl()).toBe(false));
    expect(getReport).not.toHaveBeenCalled();
  });
});

describe('parseChecksums', () => {
  it('reads every entry of a multi-asset file', () => {
    const digests = parseChecksums(checksumsFor(ASSET, FAKE_BINARY));
    expect(digests.size).toBe(3);
    expect(digests.get(ASSET)).toBe(sha256(Buffer.from(FAKE_BINARY)));
  });

  it('reads entries written with CRLF line endings', () => {
    const digests = parseChecksums(
      checksumsFor(ASSET, FAKE_BINARY).replaceAll('\n', '\r\n'),
    );
    expect(digests.get(ASSET)).toBe(sha256(Buffer.from(FAKE_BINARY)));
  });

  it('reads the entry of a file marked binary with an asterisk', () => {
    const digests = parseChecksums(`${'a'.repeat(64)} *${ASSET}`);
    expect(digests.get(ASSET)).toBe('a'.repeat(64));
  });

  it('ignores blank lines and lines that hold no digest', () => {
    const digests = parseChecksums('\n# a comment\nnot a checksum line\n');
    expect(digests.size).toBe(0);
  });

  it('rejects a file with no entry for the asset', () => {
    expect(() => expectedChecksum('', ASSET)).toThrow(
      `checksums.txt has no entry for ${ASSET}`,
    );
  });
});

describe('resolveBinary', () => {
  it('reports a platform with no release asset', async () => {
    await expect(
      resolveBinary(options({ platform: 'win32', arch: 'x64' })),
    ).rejects.toThrow(
      'no prebuilt binary for win32-x64; build from source with cargo (crates/fake-tool) and set FAKE_TOOL_BINARY',
    );
  });

  it('reports a musl linux host', async () => {
    await expect(resolveBinary(options({ musl: true }))).rejects.toThrow(
      'no prebuilt binary for musl Linux, the release binaries need glibc; build from source with cargo (crates/fake-tool) and set FAKE_TOOL_BINARY',
    );
  });

  it('runs the override on a musl host', async () => {
    const binary = await resolveBinary(
      options({
        musl: true,
        env: { FAKE_TOOL_BINARY: '/opt/fake-tool' },
      }),
    );
    expect(binary).toBe('/opt/fake-tool');
  });

  it('returns the override without contacting the origin', async () => {
    const origin = await startOrigin({});
    try {
      const binary = await resolveBinary(
        options({
          env: {
            FAKE_TOOL_BINARY: '/opt/fake-tool',
            FAKE_TOOL_DOWNLOAD_BASE: origin.base,
          },
        }),
      );
      expect(binary).toBe('/opt/fake-tool');
      expect(origin.requests).toStrictEqual([]);
      expect(notices).toStrictEqual([]);
    } finally {
      await origin.close();
    }
  });

  it('downloads, verifies and caches the release asset', async () => {
    packageChecksums(FAKE_BINARY);
    const origin = await startOrigin({ [ASSET]: FAKE_BINARY });
    try {
      const binary = await resolveBinary(
        options({ env: { FAKE_TOOL_DOWNLOAD_BASE: origin.base } }),
      );
      expect(binary).toBe(
        join(install, 'cache', 'fake-tool-0.1.0-x86_64-unknown-linux-gnu'),
      );
      expect(statSync(binary).mode & 0o777).toBe(0o755);
      expect(spawnSync(binary, ['check'], { encoding: 'utf8' }).stdout).toBe(
        'fake-tool check\n',
      );
      expect(origin.requests).toStrictEqual([ASSET]);
      expect(notices).toStrictEqual([
        'downloading fake-tool-x86_64-unknown-linux-gnu (v0.1.0)',
      ]);
    } finally {
      await origin.close();
    }
  });

  it('fetches from the package release on GitHub by default', async () => {
    packageChecksums(FAKE_BINARY);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await expect(resolveBinary(options())).rejects.toThrow(
      `download failed for https://github.com/OpenZeppelin/compact-tools/releases/download/fake-tools/v0.1.0/${ASSET}: offline`,
    );
  });

  it('serves a second run from the cache', async () => {
    packageChecksums(FAKE_BINARY);
    const origin = await startOrigin({ [ASSET]: FAKE_BINARY });
    try {
      const first = await resolveBinary(
        options({ env: { FAKE_TOOL_DOWNLOAD_BASE: origin.base } }),
      );
      const second = await resolveBinary(
        options({ env: { FAKE_TOOL_DOWNLOAD_BASE: origin.base } }),
      );
      expect(second).toBe(first);
      expect(origin.requests).toHaveLength(1);
      expect(notices).toHaveLength(1);
    } finally {
      await origin.close();
    }
  });

  it('rejects an asset whose digest does not match the package checksums', async () => {
    packageChecksums('a different binary');
    const origin = await startOrigin({ [ASSET]: FAKE_BINARY });
    try {
      const expected = sha256(Buffer.from('a different binary'));
      const actual = sha256(Buffer.from(FAKE_BINARY));
      await expect(
        resolveBinary(
          options({ env: { FAKE_TOOL_DOWNLOAD_BASE: origin.base } }),
        ),
      ).rejects.toThrow(
        `checksum mismatch for ${ASSET}: expected ${expected}, got ${actual}`,
      );
    } finally {
      await origin.close();
    }
  });

  it('ignores a checksums.txt replaced on the release', async () => {
    packageChecksums(FAKE_BINARY);
    const replaced = '#!/bin/sh\necho replaced\n';
    const origin = await startOrigin({
      [ASSET]: replaced,
      'checksums.txt': checksumsFor(ASSET, replaced),
    });
    try {
      await expect(
        resolveBinary(
          options({ env: { FAKE_TOOL_DOWNLOAD_BASE: origin.base } }),
        ),
      ).rejects.toThrow(`checksum mismatch for ${ASSET}`);
      expect(origin.requests).toStrictEqual([ASSET]);
    } finally {
      await origin.close();
    }
  });

  it('refuses to download without the package checksums', async () => {
    const origin = await startOrigin({ [ASSET]: FAKE_BINARY });
    try {
      await expect(
        resolveBinary(
          options({ env: { FAKE_TOOL_DOWNLOAD_BASE: origin.base } }),
        ),
      ).rejects.toThrow(
        `${join(install, 'checksums.txt')} is missing, so a download cannot be verified; set FAKE_TOOL_BINARY`,
      );
      expect(origin.requests).toStrictEqual([]);
    } finally {
      await origin.close();
    }
  });

  it('rejects an origin that answers with an http error', async () => {
    packageChecksums(FAKE_BINARY);
    const origin = await startOrigin({});
    try {
      await expect(
        resolveBinary(
          options({ env: { FAKE_TOOL_DOWNLOAD_BASE: origin.base } }),
        ),
      ).rejects.toThrow(
        `download failed for ${origin.base}/${ASSET}: HTTP 404`,
      );
    } finally {
      await origin.close();
    }
  });

  it('rejects an origin that cannot be reached', async () => {
    packageChecksums(FAKE_BINARY);
    await expect(
      resolveBinary(
        options({
          env: { FAKE_TOOL_DOWNLOAD_BASE: 'http://127.0.0.1:1/download' },
        }),
      ),
    ).rejects.toThrow('download failed for http://127.0.0.1:1/download/');
  });
});
