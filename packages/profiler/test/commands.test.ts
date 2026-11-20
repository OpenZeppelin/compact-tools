import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileCommandError, runCheck } from '../src/commands.ts';
import { resolveProfileBinary, runProfileBinary } from '../src/launcher.ts';
import { compareVersions, slugify } from '../src/manifest.ts';
import { declaredNodes } from '../src/transaction.ts';

let dir: string;

/** A stand-in binary: prints its arguments to stdout, `err` to stderr, exits `status`. */
function stub(status: number): string {
  const path = join(dir, `stub-${status}`);
  writeFileSync(path, `#!/bin/sh\necho "$*"\necho err >&2\nexit ${status}\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'compact-profiler-commands-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveProfileBinary', () => {
  it('returns an explicit binary without reading the environment', async () => {
    expect(await resolveProfileBinary({ binary: '/opt/compact-profile' })).toBe(
      '/opt/compact-profile',
    );
  });
});

describe('runProfileBinary', () => {
  it('collects stdout, stderr and the exit code', async () => {
    const run = await runProfileBinary(['cost', 'a.tx'], { binary: stub(3) });

    expect(run).toStrictEqual({
      exitCode: 3,
      stdout: 'cost a.tx\n',
      stderr: 'err\n',
    });
  });

  it('rejects when the binary cannot start', async () => {
    await expect(
      runProfileBinary(['cost'], { binary: join(dir, 'missing') }),
    ).rejects.toThrow(`cannot run ${join(dir, 'missing')}`);
  });
});

describe('runCheck', () => {
  it('passes every network, the snapshot and the size tolerance', async () => {
    const run = await runCheck({
      binary: stub(0),
      manifest: 'm.json',
      networks: ['mainnet', 'preprod'],
      snapshot: 's.json',
      sizeTolerance: 3,
    });

    expect(run.stdout).toBe(
      'check --manifest m.json --network mainnet --network preprod --snapshot s.json --reporter table --size-tolerance 3\n',
    );
  });

  it('runs update and appends the profile file', async () => {
    const run = await runCheck({
      binary: stub(0),
      manifest: 'm.json',
      networks: ['mainnet'],
      snapshot: 's.json',
      update: true,
      reporter: 'json',
      profileFile: 'p.toml',
    });

    expect(run.stdout).toBe(
      'update --manifest m.json --network mainnet --snapshot s.json --reporter json --profile-file p.toml\n',
    );
  });

  it('throws on a non-zero exit, keeping the output', async () => {
    const failure = await runCheck({
      binary: stub(1),
      manifest: 'm.json',
      networks: ['mainnet'],
      snapshot: 's.json',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProfileCommandError);
    expect(failure).toMatchObject({
      message:
        'compact-profile check --manifest m.json --network mainnet --snapshot s.json --reporter table exited 1\ncheck --manifest m.json --network mainnet --snapshot s.json --reporter table\nerr',
      exitCode: 1,
      stdout:
        'check --manifest m.json --network mainnet --snapshot s.json --reporter table\n',
      stderr: 'err\n',
    });
  });

  it('rejects an empty network list', async () => {
    await expect(
      runCheck({ manifest: 'm.json', networks: [], snapshot: 's.json' }),
    ).rejects.toThrow('runCheck needs at least one network');
  });
});

describe('declaredNodes', () => {
  const tag = new TextEncoder().encode(
    'midnight:transaction[v12](signature[v2],proof-preimage,embedded-fr[v1]):',
  );
  const payload = (...count: number[]) =>
    new Uint8Array([...tag, ...count, 0xff]);

  it('reads the single-byte mode', () => {
    expect(declaredNodes(payload(63 << 2))).toBe(63);
  });

  it('reads the two-byte mode', () => {
    expect(declaredNodes(payload(0x65, 0x01))).toBe(89);
  });

  it('reads the four-byte mode', () => {
    expect(declaredNodes(payload(0x02, 0x00, 0x01, 0x00))).toBe(0x4000);
  });

  it('reads the big-integer mode', () => {
    expect(declaredNodes(payload(0x03, 0x00, 0x00, 0x00, 0x40))).toBe(
      0x4000_0000,
    );
  });

  it('rejects a node count cut short in any mode', () => {
    for (const count of [[], [0x65], [0x02, 0x00, 0x01], [0x03, 0x00, 0x00]]) {
      expect(() => declaredNodes(new Uint8Array([...tag, ...count]))).toThrow(
        'truncated node count',
      );
    }
  });

  it('rejects bytes with no tag header', () => {
    expect(() => declaredNodes(new Uint8Array(600))).toThrow(
      'no tag header ends within the first 512 bytes',
    );
  });
});

describe('compareVersions', () => {
  it('orders a prerelease below its release', () => {
    expect(compareVersions('1.0.0-rc.5', '1.0.2')).toBe(-1);
    expect(compareVersions('1.0.0-rc.5', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.2', '1.0.2')).toBe(0);
    expect(compareVersions('1.0.10', '1.0.2')).toBe(1);
  });

  it('orders prerelease identifiers numerically, then lexically', () => {
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-rc', '1.0.0-rc.1')).toBe(-1);
  });
});

describe('slugify', () => {
  it('lower-cases a name and joins its words with dashes', () => {
    expect(slugify('_mint multi-call n=4')).toBe('_mint-multi-call-n-4');
  });

  it('rejects a name with no file-name characters', () => {
    expect(() => slugify('!!')).toThrow('has no file name');
  });
});
