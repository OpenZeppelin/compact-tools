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
import { CompactCompiler, FileDiscovery } from '@openzeppelin/compact-builder';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  builderExcludes,
  CompactTomlParseError,
  findCompactToml,
  hasMockTable,
  MockBuildError,
  type MockBuildHost,
  MockerNotInstalledError,
  mockBuildArgs,
  mockExcludes,
  nodeHost,
  prepareCompile,
  resolveMocker,
} from '../src/mockBuild.ts';

const MOCK_TOML = `[mock]
spdx = "MIT"

[[mock.rules]]
modules = ["**"]
`;

/** The compiler excludes for the default `test_dir`. */
const DEFAULT_EXCLUDES = [
  '--exclude',
  '*/test/artifacts/*',
  '--exclude',
  '*.fragment.compact',
];

interface Run {
  command: string;
  args: readonly string[];
  cwd: string;
}

/** A host over an in-memory file tree. Nothing outside `files` and `dirs` exists. */
function memoryHost(
  files: Record<string, string>,
  overrides: Partial<MockBuildHost> & {
    dirs?: string[];
    exit?: number | string;
  } = {},
): MockBuildHost & { runs: Run[]; logs: string[] } {
  const { dirs = [], exit = 0, ...rest } = overrides;
  const runs: Run[] = [];
  const logs: string[] = [];
  return {
    cwd: '/repo',
    env: { COMPACT_MOCK_BINARY: '/bin/compact-mock' },
    execPath: '/usr/bin/node',
    isFile: (path) => Object.hasOwn(files, path),
    isDirectory: (path) => dirs.includes(path),
    readFile: (path) => {
      if (!Object.hasOwn(files, path)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return files[path];
    },
    resolvePackageJson: () => undefined,
    run: async (command, args, cwd) => {
      runs.push({ command, args, cwd });
      return exit;
    },
    log: (message) => logs.push(message),
    ...rest,
    runs,
    logs,
  };
}

const options = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  CompactCompiler.parseArgs(args, env);

describe('findCompactToml', () => {
  it('returns the nearest compact.toml walking up from cwd', () => {
    const host = memoryHost({
      '/repo/compact.toml': '',
      '/repo/packages/a/compact.toml': '',
    });

    expect(findCompactToml('/repo/packages/a/src/x', host)).toBe(
      '/repo/packages/a/compact.toml',
    );
    expect(findCompactToml('/repo/packages/b', host)).toBe(
      '/repo/compact.toml',
    );
  });

  it('returns undefined when no directory up to the root holds one', () => {
    expect(findCompactToml('/repo/packages/a', memoryHost({}))).toBeUndefined();
  });
});

describe('hasMockTable', () => {
  const check = (toml: string) =>
    hasMockTable(
      '/repo/compact.toml',
      memoryHost({ '/repo/compact.toml': toml }),
    );

  it('is true for a [mock] table', () => {
    expect(check(MOCK_TOML)).toBe(true);
  });

  it('is true for a table that holds only [[mock.rules]]', () => {
    expect(check('[[mock.rules]]\nmodules = ["**"]\n')).toBe(true);
  });

  it('is false without a top-level mock table', () => {
    expect(check('[lint]\ninclude = ["src/**"]\n')).toBe(false);
    expect(check('[contracts.mock]\nartifact = "x"\n')).toBe(false);
    expect(check('mock = 1\n')).toBe(false);
    expect(check('mock = [1]\n')).toBe(false);
    expect(check('mock = 1979-05-27\n')).toBe(false);
  });

  it('throws CompactTomlParseError naming the file for invalid TOML', () => {
    expect(() => check('[mock\n')).toThrow(CompactTomlParseError);
    expect(() => check('[mock\n')).toThrow(
      /^cannot parse \/repo\/compact\.toml: /,
    );
  });

  it('throws CompactTomlParseError for a file it cannot read', () => {
    const host = memoryHost(
      {},
      {
        readFile: () => {
          throw new Error('EACCES: permission denied');
        },
      },
    );

    expect(() => hasMockTable('/repo/compact.toml', host)).toThrow(
      'cannot parse /repo/compact.toml: EACCES: permission denied',
    );
  });
});

describe('resolveMocker', () => {
  const installed = (bin: unknown) =>
    memoryHost(
      {
        '/repo/node_modules/@openzeppelin/compact-mocker/package.json':
          JSON.stringify({ name: '@openzeppelin/compact-mocker', bin }),
      },
      {
        env: {},
        resolvePackageJson: (cwd, name) =>
          cwd === '/repo' && name === '@openzeppelin/compact-mocker'
            ? '/repo/node_modules/@openzeppelin/compact-mocker/package.json'
            : undefined,
      },
    );

  it('runs COMPACT_MOCK_BINARY first, even with the package installed', () => {
    const host = installed({ 'compact-mock': 'dist/compactMock.js' });

    expect(
      resolveMocker({ ...host, env: { COMPACT_MOCK_BINARY: '/opt/mock' } }),
    ).toEqual({ command: '/opt/mock', args: [] });
  });

  it("runs the package's compact-mock bin with this Node", () => {
    expect(
      resolveMocker(installed({ 'compact-mock': 'dist/compactMock.js' })),
    ).toEqual({
      command: '/usr/bin/node',
      args: [
        '/repo/node_modules/@openzeppelin/compact-mocker/dist/compactMock.js',
      ],
    });
  });

  it('accepts a string bin', () => {
    expect(resolveMocker(installed('dist/compactMock.js'))?.args).toEqual([
      '/repo/node_modules/@openzeppelin/compact-mocker/dist/compactMock.js',
    ]);
  });

  it('returns undefined when the package is missing or has no compact-mock bin', () => {
    expect(resolveMocker(memoryHost({}, { env: {} }))).toBeUndefined();
    expect(resolveMocker(installed({ other: 'x.js' }))).toBeUndefined();
    expect(resolveMocker(installed(undefined))).toBeUndefined();
  });
});

describe('mockBuildArgs', () => {
  const CFG = '/repo/compact.toml';

  it('passes the version, --skip-zk, the search directory and the config', () => {
    expect(
      mockBuildArgs(options(['+0.36.0', '--skip-zk', '--dir', 'access']), CFG),
    ).toEqual([
      'build',
      '+0.36.0',
      '--skip-zk',
      '--dir',
      'src/access',
      '--config',
      CFG,
    ]);
  });

  it('scopes --dir to --src', () => {
    expect(mockBuildArgs(options(['--src', 'custom']), CFG)).toEqual([
      'build',
      '--dir',
      'custom',
      '--config',
      CFG,
    ]);
    expect(
      mockBuildArgs(options(['--src', 'contracts/src', '--dir', 'token']), CFG),
    ).toEqual(['build', '--dir', 'contracts/src/token', '--config', CFG]);
  });

  it('passes --skip-zk for SKIP_ZK=true', () => {
    expect(mockBuildArgs(options([], { SKIP_ZK: 'true' }), CFG)).toEqual([
      'build',
      '--skip-zk',
      '--dir',
      'src',
      '--config',
      CFG,
    ]);
  });

  it('forwards --only and the compiler flags, and no other compiler argument', () => {
    const args = mockBuildArgs(
      options([
        '--only',
        'Mock*.compact',
        '--exclude',
        'x.compact',
        '--out',
        'build',
        '--hierarchical',
        '--verbose',
        '--skip-zk-ish',
      ]),
      CFG,
    );

    expect(args).toEqual([
      'build',
      '--dir',
      'src',
      '--only',
      'Mock*.compact',
      '--config',
      CFG,
      '--',
      '--verbose',
      '--skip-zk-ish',
    ]);
  });

  it("forwards each --only glob, as in the README's --only 'MockEcdsa.compact'", () => {
    expect(
      mockBuildArgs(
        options(['--dir', 'crypto', '--only', 'MockEcdsa.compact']),
        CFG,
      ),
    ).toEqual([
      'build',
      '--dir',
      'src/crypto',
      '--only',
      'MockEcdsa.compact',
      '--config',
      CFG,
    ]);
    expect(
      mockBuildArgs(options(['--only', 'A.compact', '--only', '*/b/*']), CFG),
    ).toEqual([
      'build',
      '--dir',
      'src',
      '--only',
      'A.compact',
      '--only',
      '*/b/*',
      '--config',
      CFG,
    ]);
  });

  it('passes --compact-path and --no-communications-commitment after --', () => {
    expect(
      mockBuildArgs(
        options([
          '--skip-zk',
          '--compact-path',
          '/opt/compact/lib',
          '--no-communications-commitment',
        ]),
        CFG,
      ),
    ).toEqual([
      'build',
      '--skip-zk',
      '--dir',
      'src',
      '--config',
      CFG,
      '--',
      '--compact-path',
      '/opt/compact/lib',
      '--no-communications-commitment',
    ]);
  });

  it('passes --skip-zk once and never after --', () => {
    expect(
      mockBuildArgs(
        options(['--skip-zk', '--verbose'], { SKIP_ZK: 'true' }),
        CFG,
      ),
    ).toEqual([
      'build',
      '--skip-zk',
      '--dir',
      'src',
      '--config',
      CFG,
      '--',
      '--verbose',
    ]);
    expect(
      mockBuildArgs(options(['--skip-zk'], { SKIP_ZK: 'true' }), CFG),
    ).toEqual(['build', '--skip-zk', '--dir', 'src', '--config', CFG]);
  });

  it('emits no -- without other compiler flags', () => {
    expect(mockBuildArgs(options([]), CFG)).toEqual([
      'build',
      '--dir',
      'src',
      '--config',
      CFG,
    ]);
    expect(mockBuildArgs({ flags: '  ' }, CFG)).toEqual([
      'build',
      '--dir',
      'src',
      '--config',
      CFG,
    ]);
  });
});

describe('mockExcludes', () => {
  it('globs the artifacts directory under test_dir, and fragments', () => {
    expect(mockExcludes(undefined)).toEqual([
      '*/test/artifacts/*',
      '*.fragment.compact',
    ]);
    expect(mockExcludes('{dir}/test')).toEqual([
      '*/test/artifacts/*',
      '*.fragment.compact',
    ]);
    expect(mockExcludes('{dir}/test/unit')).toEqual([
      '*/test/unit/artifacts/*',
      '*.fragment.compact',
    ]);
    expect(mockExcludes('{dir}/./test//unit/')).toEqual([
      '*/test/unit/artifacts/*',
      '*.fragment.compact',
    ]);
  });

  it('falls back to the default for a test_dir compact-mock rejects', () => {
    for (const testDir of [
      'tests',
      'test/unit',
      '{dir}',
      '{dir}/',
      '{dir}/.',
      '{dir}//test/unit',
      '{dir}/../test',
      '{dir}/test/../unit',
      '{dir}/{module}',
      '{dir}/test}',
      '{dir}/test\\unit',
      42,
      ['{dir}/test/unit'],
    ]) {
      expect(mockExcludes(testDir)).toEqual([
        '*/test/artifacts/*',
        '*.fragment.compact',
      ]);
    }
  });
});

describe('builderExcludes', () => {
  it('uses the default test_dir without a compact.toml or a [mock] table', () => {
    expect(builderExcludes(memoryHost({}))).toEqual([
      '*/test/artifacts/*',
      '*.fragment.compact',
    ]);
    expect(
      builderExcludes(memoryHost({ '/repo/compact.toml': '[lint]\n' })),
    ).toEqual(['*/test/artifacts/*', '*.fragment.compact']);
  });

  it('reads test_dir from the nearest [mock] table', () => {
    const host = memoryHost({
      '/repo/compact.toml': '[mock]\ntest_dir = "{dir}/test/unit"\n',
    });

    expect(builderExcludes(host)).toEqual([
      '*/test/unit/artifacts/*',
      '*.fragment.compact',
    ]);
  });

  it('throws CompactTomlParseError for an invalid nearest compact.toml', () => {
    expect(() =>
      builderExcludes(memoryHost({ '/repo/compact.toml': '[mock\n' })),
    ).toThrow(CompactTomlParseError);
  });
});

describe('prepareCompile', () => {
  const withMock = (
    extra: Partial<MockBuildHost> & { exit?: number | string } = {},
  ) =>
    memoryHost(
      { '/repo/compact.toml': MOCK_TOML },
      { dirs: ['/repo/src', '/repo/src/access'], ...extra },
    );

  it('returns the arguments unchanged and runs nothing without a compact.toml', async () => {
    const host = memoryHost({}, { dirs: ['/repo/src'] });

    expect(
      await prepareCompile(['--dir', 'access', '--skip-zk'], host),
    ).toEqual(['--dir', 'access', '--skip-zk']);
    expect(host.runs).toEqual([]);
  });

  it('returns the arguments unchanged and runs nothing without a [mock] table', async () => {
    const host = memoryHost(
      { '/repo/compact.toml': '[lint]\n' },
      { dirs: ['/repo/src'] },
    );

    expect(await prepareCompile(['+0.36.0'], host)).toEqual(['+0.36.0']);
    expect(host.runs).toEqual([]);
  });

  it('strips --no-mocks with or without a [mock] table', async () => {
    expect(
      await prepareCompile(
        ['--no-mocks', '--skip-zk', '--no-mocks'],
        memoryHost({}),
      ),
    ).toEqual(['--skip-zk']);
  });

  it('lets a nearer compact.toml without [mock] hide a farther one with it', async () => {
    const host = memoryHost(
      {
        '/repo/compact.toml': MOCK_TOML,
        '/repo/contracts/compact.toml': '[lint]\n',
      },
      { cwd: '/repo/contracts', dirs: ['/repo/contracts/src'] },
    );

    expect(await prepareCompile([], host)).toEqual([]);
    expect(host.runs).toEqual([]);
  });

  it('rejects an invalid nearest compact.toml before running anything', async () => {
    const host = memoryHost(
      { '/repo/compact.toml': 'mock = [' },
      { dirs: ['/repo/src'] },
    );

    await expect(prepareCompile([], host)).rejects.toThrow(
      CompactTomlParseError,
    );
    expect(host.runs).toEqual([]);
  });

  it('builds the mocks of the search directory and appends the excludes', async () => {
    const host = withMock();

    const args = await prepareCompile(
      [
        '+0.36.0',
        '--dir',
        'access',
        '--skip-zk',
        '--only',
        'A.compact',
        '--no-communications-commitment',
      ],
      host,
    );

    expect(host.logs).toEqual(['[COMPILE] Building mocks (compact-mock)']);
    expect(host.runs).toEqual([
      {
        command: '/bin/compact-mock',
        args: [
          'build',
          '+0.36.0',
          '--skip-zk',
          '--dir',
          'src/access',
          '--only',
          'A.compact',
          '--config',
          '/repo/compact.toml',
          '--',
          '--no-communications-commitment',
        ],
        cwd: '/repo',
      },
    ]);
    expect(args).toEqual([
      '+0.36.0',
      '--dir',
      'access',
      '--skip-zk',
      '--only',
      'A.compact',
      '--no-communications-commitment',
      '--exclude',
      '*/test/artifacts/*',
      '--exclude',
      '*.fragment.compact',
    ]);
  });

  it('keeps the excludes and runs nothing with --no-mocks', async () => {
    const host = withMock();

    expect(
      await prepareCompile(['--no-mocks', '--dir', 'access'], host),
    ).toEqual(['--dir', 'access', ...DEFAULT_EXCLUDES]);
    expect(host.runs).toEqual([]);
  });

  it('excludes the artifacts directory under [mock].test_dir', async () => {
    const host = memoryHost({
      '/repo/compact.toml': '[mock]\ntest_dir = "{dir}/test/unit"\n',
    });

    expect(await prepareCompile(['--no-mocks'], host)).toEqual([
      '--exclude',
      '*/test/unit/artifacts/*',
      '--exclude',
      '*.fragment.compact',
    ]);
  });

  it('skips the build for a search directory that does not exist', async () => {
    const host = withMock();

    expect(await prepareCompile(['--dir', 'missing'], host)).toEqual([
      '--dir',
      'missing',
      ...DEFAULT_EXCLUDES,
    ]);
    expect(host.runs).toEqual([]);
  });

  it('runs the installed package bin when COMPACT_MOCK_BINARY is unset', async () => {
    const manifest =
      '/repo/node_modules/@openzeppelin/compact-mocker/package.json';
    const host = memoryHost(
      {
        '/repo/compact.toml': MOCK_TOML,
        [manifest]: JSON.stringify({ bin: { 'compact-mock': 'dist/m.js' } }),
      },
      {
        env: {},
        dirs: ['/repo/src'],
        resolvePackageJson: () => manifest,
      },
    );

    await prepareCompile([], host);

    expect(host.runs[0].command).toBe('/usr/bin/node');
    expect(host.runs[0].args.slice(0, 2)).toEqual([
      '/repo/node_modules/@openzeppelin/compact-mocker/dist/m.js',
      'build',
    ]);
  });

  it('throws MockerNotInstalledError when no compact-mock can be found', async () => {
    const host = withMock({ env: {} });

    await expect(prepareCompile([], host)).rejects.toThrow(
      new MockerNotInstalledError('/repo/compact.toml'),
    );
    await expect(prepareCompile([], host)).rejects.toThrow(
      '/repo/compact.toml has a [mock] table, but @openzeppelin/compact-mocker is not installed',
    );
    expect(host.runs).toEqual([]);
  });

  it('throws MockBuildError with the exit code of a failed build', async () => {
    await expect(prepareCompile([], withMock({ exit: 2 }))).rejects.toThrow(
      new MockBuildError('compact-mock exit 2'),
    );
    await expect(prepareCompile([], withMock({ exit: 1 }))).rejects.toThrow(
      'Mock build failed (compact-mock exit 1)',
    );
  });

  it('throws MockBuildError naming the signal that ended the build', async () => {
    await expect(
      prepareCompile([], withMock({ exit: 'SIGTERM' })),
    ).rejects.toThrow('Mock build failed (compact-mock killed by SIGTERM)');
  });

  it('throws MockBuildError when compact-mock cannot start', async () => {
    const host = withMock({
      run: async () => {
        throw new Error('spawn /bin/compact-mock ENOENT');
      },
    });

    await expect(prepareCompile([], host)).rejects.toThrow(
      'Mock build failed (cannot run /bin/compact-mock: spawn /bin/compact-mock ENOENT)',
    );
  });
});

describe('nodeHost', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'compact-cli-mock-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A `compact-mock` stand-in that records its argv and cwd, then exits with `code`. */
  function stubMocker(code: number): { path: string; record: string } {
    const path = join(dir, 'compact-mock-stub');
    const record = join(dir, 'argv.json');
    writeFileSync(
      path,
      `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.exit(${code});
`,
    );
    chmodSync(path, 0o755);
    return { path, record };
  }

  it('tells files from directories', () => {
    writeFileSync(join(dir, 'compact.toml'), MOCK_TOML);
    mkdirSync(join(dir, 'nested', 'compact.toml'), { recursive: true });
    const host = nodeHost(() => {});

    expect(host.isFile(join(dir, 'compact.toml'))).toBe(true);
    expect(host.isFile(join(dir, 'nested', 'compact.toml'))).toBe(false);
    expect(host.isDirectory(join(dir, 'nested'))).toBe(true);
    expect(host.isDirectory(join(dir, 'missing'))).toBe(false);
    expect(host.readFile(join(dir, 'compact.toml'))).toBe(MOCK_TOML);
    expect(findCompactToml(join(dir, 'nested'), host)).toBe(
      join(dir, 'compact.toml'),
    );
  });

  it('resolves the mocker package from cwd', () => {
    const pkg = join(dir, 'node_modules', '@openzeppelin', 'compact-mocker');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@openzeppelin/compact-mocker' }),
    );
    const host = nodeHost(() => {});

    expect(host.resolvePackageJson(dir, '@openzeppelin/compact-mocker')).toBe(
      join(pkg, 'package.json'),
    );
    expect(
      host.resolvePackageJson(dir, '@openzeppelin/not-installed'),
    ).toBeUndefined();
  });

  it('resolves to the exit code, the signal, or rejects when the command cannot start', async () => {
    const host = nodeHost(() => {});

    await expect(
      host.run(process.execPath, ['-e', 'process.exit(3)'], dir),
    ).resolves.toBe(3);
    await expect(
      host.run(
        process.execPath,
        ['-e', "process.kill(process.pid, 'SIGTERM')"],
        dir,
      ),
    ).resolves.toBe('SIGTERM');
    await expect(
      host.run(join(dir, 'missing-binary'), [], dir),
    ).rejects.toThrow('ENOENT');
  });

  it('runs COMPACT_MOCK_BINARY in cwd with the build arguments', async () => {
    writeFileSync(join(dir, 'compact.toml'), MOCK_TOML);
    mkdirSync(join(dir, 'src', 'access'), { recursive: true });
    const stub = stubMocker(0);
    const logs: string[] = [];
    const host = {
      ...nodeHost((message) => logs.push(message)),
      cwd: dir,
      env: { COMPACT_MOCK_BINARY: stub.path },
    };

    const args = await prepareCompile(
      [
        '--dir',
        'access',
        '--skip-zk',
        '+0.36.0',
        '--only',
        'MockEcdsa.compact',
        '--no-communications-commitment',
      ],
      host,
    );

    expect(JSON.parse(readFileSync(stub.record, 'utf8'))).toEqual({
      argv: [
        'build',
        '+0.36.0',
        '--skip-zk',
        '--dir',
        'src/access',
        '--only',
        'MockEcdsa.compact',
        '--config',
        join(dir, 'compact.toml'),
        '--',
        '--no-communications-commitment',
      ],
      cwd: dir,
    });
    expect(logs).toEqual(['[COMPILE] Building mocks (compact-mock)']);
    expect(args.slice(-4)).toEqual(DEFAULT_EXCLUDES);
  });

  it('reports the exit code of a failing COMPACT_MOCK_BINARY', async () => {
    writeFileSync(join(dir, 'compact.toml'), MOCK_TOML);
    mkdirSync(join(dir, 'src'));
    const stub = stubMocker(2);
    const host = {
      ...nodeHost(() => {}),
      cwd: dir,
      env: { COMPACT_MOCK_BINARY: stub.path },
    };

    await expect(prepareCompile([], host)).rejects.toThrow(
      'Mock build failed (compact-mock exit 2)',
    );
  });
});

describe('the compiler walk under the mock excludes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'compact-cli-walk-'));
    for (const file of [
      'Top.compact',
      'artifacts/Top.compact',
      'lib/Inner.compact',
      'lib/artifacts/Inner.compact',
      'lib/test/MockHand.compact',
      'lib/test/Inner.fragment.compact',
      'lib/test/artifacts/MockInner.compact',
      'lib/test/unit/artifacts/MockUnit.compact',
      'test/artifacts/MockTop.compact',
    ]) {
      const path = join(dir, 'src', file);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, '');
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The files under `src` the compiler keeps after `prepareCompile` with `toml`. */
  async function walk(toml: string): Promise<string[]> {
    const args = await prepareCompile(
      ['--no-mocks'],
      memoryHost({ '/repo/compact.toml': toml }),
    );
    const { exclude } = CompactCompiler.parseArgs(args, {});
    const src = join(dir, 'src');
    return (await new FileDiscovery(src, exclude).getCompactFiles(src)).sort();
  }

  it('keeps sources under an artifacts directory outside test_dir', async () => {
    expect(await walk('[mock]\n')).toEqual([
      'Top.compact',
      'artifacts/Top.compact',
      'lib/Inner.compact',
      'lib/artifacts/Inner.compact',
      'lib/test/MockHand.compact',
      'lib/test/unit/artifacts/MockUnit.compact',
    ]);
  });

  it('drops only the artifacts directory under a custom test_dir', async () => {
    expect(await walk('[mock]\ntest_dir = "{dir}/test/unit"\n')).toEqual([
      'Top.compact',
      'artifacts/Top.compact',
      'lib/Inner.compact',
      'lib/artifacts/Inner.compact',
      'lib/test/MockHand.compact',
      'lib/test/artifacts/MockInner.compact',
      'test/artifacts/MockTop.compact',
    ]);
  });
});
