import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageDir } from '../src/launcher.ts';
import { binaryUnderTest } from './binaryUnderTest.ts';
import { COMPILER_VERSION, FIXTURES } from './setup.ts';

const { binary, skip } = binaryUnderTest(process.env, existsSync);
const skipped = skip !== undefined;
const title = (name: string) => (skipped ? `${name} (skipped: ${skip})` : name);

const BIN = join(packageDir, 'src', 'compactMock.ts');
const MOCK_COUNT = 14;

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'compact-mock-e2e-'));
  cpSync(FIXTURES, repo, {
    recursive: true,
    filter: (source) => basename(source) !== 'artifacts',
  });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Runs compact-mock in the temp copy, whose compact.toml is the nearest one. */
function mock(...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(binary, args, { cwd: repo, encoding: 'utf8' });
}

const lines = (text: string) => text.split('\n').filter((line) => line !== '');

describe.skipIf(skipped)(title('compact-mock generate'), () => {
  it('writes every mock, then leaves them all unchanged on a second run', () => {
    const first = mock('generate');
    const second = mock('generate');

    expect(first.status).toBe(0);
    expect(lines(first.stdout)).toHaveLength(MOCK_COUNT);
    expect(
      lines(first.stdout).every((line) => line.startsWith('wrote src/')),
    ).toBe(true);
    expect(first.stdout).toContain(
      'wrote src/access/test/artifacts/MockOwned.compact',
    );
    expect(second.status).toBe(0);
    expect(lines(second.stdout)).toEqual(
      lines(first.stdout).map((line) => line.replace(/^wrote /, 'unchanged ')),
    );
  });

  it('removes the mocks no rule produces and keeps the other names in the stamp', () => {
    expect(mock('generate').status).toBe(0);
    const config = join(repo, 'compact.toml');
    const text = readFileSync(config, 'utf8');
    // A rule that applies to no module is an error, so the Scale rule goes with math/.
    writeFileSync(
      config,
      text
        .slice(0, text.indexOf('# scale keeps its name'))
        .replace(
          'exclude = ["auth/Keyed", "rand/*"]',
          'exclude = ["auth/Keyed", "rand/*", "math/*"]',
        )
        .replace('  { suffix = "NoInit", init = "none" },\n', ''),
    );

    const run = mock('generate');

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toContain(
      'removed src/generic/test/artifacts/MockBagNoInit.compact',
    );
    expect(lines(run.stdout)).toContain(
      'removed src/math/test/artifacts/MockScale.compact',
    );
    const generic = join(repo, 'src', 'generic', 'test', 'artifacts');
    expect(readdirSync(generic).sort()).toEqual([
      '.compact-mock-stamp',
      'MockBag.compact',
      'MockBagPair.compact',
    ]);
    expect(
      lines(readFileSync(join(generic, '.compact-mock-stamp'), 'utf8')).filter(
        (line) => !line.startsWith('#'),
      ),
    ).toEqual(['MockBag', 'MockBagPair']);
    expect(existsSync(join(repo, 'src', 'math', 'test', 'artifacts'))).toBe(
      false,
    );
  });

  it('runs through the compact-mock bin with COMPACT_MOCK_BINARY', () => {
    const run = spawnSync(process.execPath, [BIN, 'generate'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, COMPACT_MOCK_BINARY: binary },
    });

    expect(run.status).toBe(0);
    expect(lines(run.stdout)).toHaveLength(MOCK_COUNT);
  });
});

describe.skipIf(skipped)(title('compact-mock build'), () => {
  it('succeeds with no mock under --dir', () => {
    const run = mock(
      'build',
      `+${COMPILER_VERSION}`,
      '--skip-zk',
      '--dir',
      'src/identity',
    );

    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(existsSync(join(repo, 'src', 'identity', 'test'))).toBe(false);
  });

  it('exits 2 for a --dir that does not exist', () => {
    expect(mock('build', '--dir', 'src/missing').status).toBe(2);
  });

  it('exits 2 before compiling when a mock breaks the interface it implements', () => {
    const iface = join(repo, 'src', 'iface', 'Counting.compact');
    writeFileSync(
      iface,
      readFileSync(iface, 'utf8').replace(
        'circuit bump(n: Uint<16>): [];',
        'circuit bump(n: Uint<32>): [];',
      ),
    );

    const run = mock(
      'build',
      `+${COMPILER_VERSION}`,
      '--skip-zk',
      '--dir',
      'src/count',
    );

    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(
      'implements Tally, but its circuit bump takes (Uint<16>) where Tally declares (Uint<32>)',
    );
  });
});

describe.skipIf(skipped)(title('compact-compiler with a [mock] table'), () => {
  /** `compact-compiler +<version> --skip-zk --dir count` in the temp copy. */
  function compile(...extra: string[]): SpawnSyncReturns<string> {
    const runCompiler = createRequire(import.meta.url).resolve(
      '@openzeppelin/compact-cli/run-compiler',
    );
    return spawnSync(
      process.execPath,
      [
        runCompiler,
        `+${COMPILER_VERSION}`,
        '--skip-zk',
        '--dir',
        'count',
        ...extra,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, COMPACT_MOCK_BINARY: binary },
      },
    );
  }

  const mockArtifacts = () => join(repo, 'src', 'count', 'test', 'artifacts');

  it('builds the mocks of its --dir first and leaves generated sources and fragments out of its own compile', () => {
    const run = compile();

    expect(run.status).toBe(0);
    expect(
      existsSync(join(mockArtifacts(), 'MockClicker', 'contract', 'index.js')),
    ).toBe(true);
    expect(existsSync(join(repo, 'src', 'access', 'test', 'artifacts'))).toBe(
      false,
    );
    expect(readdirSync(join(repo, 'artifacts'))).toEqual(['Clicker']);
  });

  it('builds no mocks under --no-mocks and still skips the fragment', () => {
    const run = compile('--no-mocks');

    expect(run.status).toBe(0);
    expect(existsSync(mockArtifacts())).toBe(false);
    expect(readdirSync(join(repo, 'artifacts'))).toEqual(['Clicker']);
  });
});
