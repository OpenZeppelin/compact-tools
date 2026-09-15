import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  expectedChecksum,
  parseChecksums,
  resolveBinary,
  resolveTarget,
  sha256,
} from '../src/binary.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE_BINARY = '#!/bin/sh\necho fake-lint "$@"\n';
const ASSET = 'compact-lint-x86_64-unknown-linux-gnu';

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
    `${'0'.repeat(64)}  compact-lint-aarch64-apple-darwin`,
    `${digest}  ${asset}`,
    `${'1'.repeat(64)}  compact-lint-aarch64-unknown-linux-gnu`,
  ].join('\n');
}

let install: string;
let notices: string[];

function options(
  overrides: Partial<Parameters<typeof resolveBinary>[0]> = {},
): Parameters<typeof resolveBinary>[0] {
  return {
    packageDir: install,
    version: '0.1.0',
    platform: 'linux',
    arch: 'x64',
    env: {},
    notify: (message) => notices.push(message),
    ...overrides,
  };
}

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), 'compact-lint-pkg-'));
  notices = [];
});

afterEach(() => {
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
      'no prebuilt binary for win32-x64; build from source with cargo (crates/compact-lint) and set COMPACT_LINT_BINARY',
    );
  });

  it('returns COMPACT_LINT_BINARY without contacting the origin', async () => {
    const origin = await startOrigin({});
    try {
      const binary = await resolveBinary(
        options({
          env: {
            COMPACT_LINT_BINARY: '/opt/compact-lint',
            COMPACT_LINT_DOWNLOAD_BASE: origin.base,
          },
        }),
      );
      expect(binary).toBe('/opt/compact-lint');
      expect(origin.requests).toStrictEqual([]);
      expect(notices).toStrictEqual([]);
    } finally {
      await origin.close();
    }
  });

  it('downloads, verifies and caches the release asset', async () => {
    const origin = await startOrigin({
      [ASSET]: FAKE_BINARY,
      'checksums.txt': checksumsFor(ASSET, FAKE_BINARY),
    });
    try {
      const binary = await resolveBinary(
        options({ env: { COMPACT_LINT_DOWNLOAD_BASE: origin.base } }),
      );
      expect(binary).toBe(
        join(install, '.cache', 'compact-lint-0.1.0-x86_64-unknown-linux-gnu'),
      );
      expect(statSync(binary).mode & 0o777).toBe(0o755);
      expect(spawnSync(binary, ['check'], { encoding: 'utf8' }).stdout).toBe(
        'fake-lint check\n',
      );
      expect(origin.requests.toSorted()).toStrictEqual([
        'checksums.txt',
        ASSET,
      ]);
      expect(notices).toStrictEqual([
        'downloading compact-lint-x86_64-unknown-linux-gnu (v0.1.0)',
      ]);
    } finally {
      await origin.close();
    }
  });

  it('serves a second run from the cache', async () => {
    const origin = await startOrigin({
      [ASSET]: FAKE_BINARY,
      'checksums.txt': checksumsFor(ASSET, FAKE_BINARY),
    });
    try {
      const first = await resolveBinary(
        options({ env: { COMPACT_LINT_DOWNLOAD_BASE: origin.base } }),
      );
      const second = await resolveBinary(
        options({ env: { COMPACT_LINT_DOWNLOAD_BASE: origin.base } }),
      );
      expect(second).toBe(first);
      expect(origin.requests).toHaveLength(2);
      expect(notices).toHaveLength(1);
    } finally {
      await origin.close();
    }
  });

  it('rejects an asset whose digest does not match checksums.txt', async () => {
    const origin = await startOrigin({
      [ASSET]: FAKE_BINARY,
      'checksums.txt': checksumsFor(ASSET, 'a different binary'),
    });
    try {
      const expected = sha256(Buffer.from('a different binary'));
      const actual = sha256(Buffer.from(FAKE_BINARY));
      await expect(
        resolveBinary(
          options({ env: { COMPACT_LINT_DOWNLOAD_BASE: origin.base } }),
        ),
      ).rejects.toThrow(
        `checksum mismatch for ${ASSET}: expected ${expected}, got ${actual}; delete ${join(install, '.cache', 'compact-lint-0.1.0-x86_64-unknown-linux-gnu')} and retry`,
      );
    } finally {
      await origin.close();
    }
  });

  it('rejects an origin that answers with an http error', async () => {
    const origin = await startOrigin({});
    try {
      await expect(
        resolveBinary(
          options({ env: { COMPACT_LINT_DOWNLOAD_BASE: origin.base } }),
        ),
      ).rejects.toThrow(
        `download failed for ${origin.base}/${ASSET}: HTTP 404`,
      );
    } finally {
      await origin.close();
    }
  });

  it('rejects an origin that cannot be reached', async () => {
    await expect(
      resolveBinary(
        options({
          env: { COMPACT_LINT_DOWNLOAD_BASE: 'http://127.0.0.1:1/download' },
        }),
      ),
    ).rejects.toThrow('download failed for http://127.0.0.1:1/download/');
  });
});

describe('the compact-lint bin', () => {
  it('passes its arguments to the binary and forwards the exit code', () => {
    const stub = join(install, 'stub-lint');
    writeFileSync(stub, '#!/bin/sh\necho "args: $*"\nexit 7\n');
    chmodSync(stub, 0o755);

    const run = spawnSync(
      process.execPath,
      [join(packageDir, 'src', 'compactLint.ts'), 'check', '--strict', 'src'],
      { encoding: 'utf8', env: { ...process.env, COMPACT_LINT_BINARY: stub } },
    );

    expect(run.stdout).toBe('args: check --strict src\n');
    expect(run.status).toBe(7);
  });

  it('exits 2 when no binary can be resolved', () => {
    const run = spawnSync(
      process.execPath,
      [join(packageDir, 'src', 'compactLint.ts'), 'check'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          COMPACT_LINT_BINARY: join(install, 'not-installed'),
        },
      },
    );

    expect(run.status).toBe(2);
    expect(run.stderr).toContain('compact-lint: cannot run');
  });
});
