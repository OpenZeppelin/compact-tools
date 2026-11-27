/**
 * The `compact-mock build` step `compact-compiler` runs before compiling when the nearest
 * `compact.toml` has a `[mock]` table, and the generated-file excludes `compact-builder`
 * shares.
 */

import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import {
  CompactCompiler,
  type CompilerOptions,
} from '@openzeppelin/compact-builder';
import { parse } from 'smol-toml';

/** Skips the mock build. Stripped before the compiler sees the arguments. */
export const NO_MOCKS_FLAG = '--no-mocks';

/** Passed to `compact-mock build` as its own flag, never after `--`. */
const SKIP_ZK_FLAG = '--skip-zk';

const DIR_PLACEHOLDER = '{dir}/';
/** `{dir}/test`, the default `[mock].test_dir`, after `{dir}/`. */
const DEFAULT_TEST_TAIL: readonly string[] = ['test'];
const FRAGMENT_GLOB = '*.fragment.compact';

export const MOCKER_PACKAGE = '@openzeppelin/compact-mocker';
export const MOCKER_BIN = 'compact-mock';

/** `compact-compiler`'s `--src` default. */
const DEFAULT_SRC_DIR = 'src';

export class CompactTomlParseError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`cannot parse ${path}: ${reason}`);
    this.name = 'CompactTomlParseError';
    this.path = path;
  }
}

export class MockerNotInstalledError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`${path} has a [mock] table, but ${MOCKER_PACKAGE} is not installed`);
    this.name = 'MockerNotInstalledError';
    this.path = path;
  }
}

export class MockBuildError extends Error {
  constructor(detail: string) {
    super(`Mock build failed (${detail})`);
    this.name = 'MockBuildError';
  }
}

/** Everything the mock step reads from or does to the outside world. */
export interface MockBuildHost {
  cwd: string;
  env: NodeJS.ProcessEnv;
  execPath: string;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
  readFile(path: string): string;
  /** The `package.json` path of `name` as resolved from `cwd`, if installed. */
  resolvePackageJson(cwd: string, name: string): string | undefined;
  /** Runs a command with inherited stdio and resolves to its exit code, or the signal that ended it. */
  run(
    command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<number | string>;
  log(message: string): void;
}

/** The program and leading arguments that start `compact-mock`. */
export interface MockerCommand {
  command: string;
  args: string[];
}

/** The nearest `compact.toml` at or above `cwd`. */
export function findCompactToml(
  cwd: string,
  host: Pick<MockBuildHost, 'isFile'>,
): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, 'compact.toml');
    if (host.isFile(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** The top-level `mock` table of a TOML file, if it has one. */
export function readMockTable(
  path: string,
  host: Pick<MockBuildHost, 'readFile'>,
): Readonly<Record<string, unknown>> | undefined {
  let document: Record<string, unknown>;
  try {
    document = parse(host.readFile(path));
  } catch (error) {
    throw new CompactTomlParseError(
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  const mock = document.mock;
  if (
    typeof mock !== 'object' ||
    mock === null ||
    Array.isArray(mock) ||
    mock instanceof Date
  ) {
    return undefined;
  }
  return mock as Record<string, unknown>;
}

/** Whether the file parses as TOML and has a top-level `mock` table. */
export function hasMockTable(
  path: string,
  host: Pick<MockBuildHost, 'readFile'>,
): boolean {
  return readMockTable(path, host) !== undefined;
}

/** The nearest `compact.toml` at or above `cwd` and its `[mock]` table, if it has one. */
function nearestMockConfig(
  host: Pick<MockBuildHost, 'cwd' | 'isFile' | 'readFile'>,
): { path: string; table: Readonly<Record<string, unknown>> } | undefined {
  const path = findCompactToml(host.cwd, host);
  if (path === undefined) {
    return undefined;
  }
  const table = readMockTable(path, host);
  return table === undefined ? undefined : { path, table };
}

/** The `test_dir` segments after `{dir}/`, or `undefined` for a value compact-mock rejects. */
function testDirTail(testDir: unknown): string[] | undefined {
  if (typeof testDir !== 'string' || !testDir.startsWith(DIR_PLACEHOLDER)) {
    return undefined;
  }
  const rest = testDir.slice(DIR_PLACEHOLDER.length);
  if (/[{}\\]/.test(rest) || rest.startsWith('/')) {
    return undefined;
  }
  const segments = rest
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  return segments.length === 0 || segments.includes('..')
    ? undefined
    : segments;
}

/**
 * Globs for the mocks compact-mock writes under `[mock].test_dir` and for fragments. A
 * malformed `test_dir` gets the default's globs, and compact-mock reports it.
 */
export function mockExcludes(testDir: unknown): string[] {
  const tail = testDirTail(testDir) ?? DEFAULT_TEST_TAIL;
  return [`*/${tail.join('/')}/artifacts/*`, FRAGMENT_GLOB];
}

/**
 * What `compact-builder` never compiles or ships: {@link mockExcludes} of the nearest
 * `compact.toml`, with the default `test_dir` when it has no `[mock]` table.
 *
 * @throws {CompactTomlParseError} The nearest `compact.toml` cannot be read or parsed.
 */
export function builderExcludes(
  host: Pick<MockBuildHost, 'cwd' | 'isFile' | 'readFile'>,
): string[] {
  return mockExcludes(nearestMockConfig(host)?.table.test_dir);
}

/** `COMPACT_MOCK_BINARY`, else the mocker package's bin run with this Node. */
export function resolveMocker(
  host: Pick<
    MockBuildHost,
    'cwd' | 'env' | 'execPath' | 'readFile' | 'resolvePackageJson'
  >,
): MockerCommand | undefined {
  const override = host.env.COMPACT_MOCK_BINARY;
  if (override) {
    return { command: override, args: [] };
  }
  const manifestPath = host.resolvePackageJson(host.cwd, MOCKER_PACKAGE);
  if (manifestPath === undefined) {
    return undefined;
  }
  const { bin } = JSON.parse(host.readFile(manifestPath)) as {
    bin?: string | Record<string, string>;
  };
  const entry = typeof bin === 'string' ? bin : bin?.[MOCKER_BIN];
  if (entry === undefined) {
    return undefined;
  }
  return {
    command: host.execPath,
    args: [join(dirname(manifestPath), entry)],
  };
}

/** The directory the compiler walks: `<srcDir>[/<targetDir>]`. */
export function searchDir(options: CompilerOptions): string {
  const srcDir = options.srcDir ?? DEFAULT_SRC_DIR;
  return options.targetDir ? join(srcDir, options.targetDir) : srcDir;
}

/**
 * `build` arguments: the toolchain version, `--skip-zk`, the scope (`--dir`, `--only`) and
 * the config, then the other compiler flags after `--` for every `compact compile` it runs.
 */
export function mockBuildArgs(
  options: CompilerOptions,
  configPath: string,
): string[] {
  const flags = (options.flags ?? '')
    .split(/\s+/)
    .filter((flag) => flag !== '');
  const compileFlags = flags.filter((flag) => flag !== SKIP_ZK_FLAG);
  const args = ['build'];
  if (options.version) {
    args.push(`+${options.version}`);
  }
  if (flags.includes(SKIP_ZK_FLAG)) {
    args.push(SKIP_ZK_FLAG);
  }
  args.push('--dir', searchDir(options));
  for (const glob of options.only ?? []) {
    args.push('--only', glob);
  }
  args.push('--config', configPath);
  if (compileFlags.length > 0) {
    args.push('--', ...compileFlags);
  }
  return args;
}

/**
 * Runs the mock build when the nearest `compact.toml` has a `[mock]` table, and returns the
 * arguments for `CompactCompiler.fromArgs`.
 *
 * @throws {CompactTomlParseError} The nearest `compact.toml` cannot be read or parsed.
 * @throws {MockerNotInstalledError} Mocks are on and no `compact-mock` can be found.
 * @throws {MockBuildError} `compact-mock` could not start or exited non-zero.
 */
export async function prepareCompile(
  argv: readonly string[],
  host: MockBuildHost,
): Promise<string[]> {
  const noMocks = argv.includes(NO_MOCKS_FLAG);
  const args = argv.filter((arg) => arg !== NO_MOCKS_FLAG);

  const config = nearestMockConfig(host);
  if (config === undefined) {
    return args;
  }

  const compilerArgs = [
    ...args,
    ...mockExcludes(config.table.test_dir).flatMap((glob) => [
      '--exclude',
      glob,
    ]),
  ];
  if (noMocks) {
    return compilerArgs;
  }
  const options = CompactCompiler.parseArgs(args, host.env);
  // A missing directory is the compiler's DirectoryNotFoundError to report.
  if (!host.isDirectory(resolve(host.cwd, searchDir(options)))) {
    return compilerArgs;
  }

  const mocker = resolveMocker(host);
  if (mocker === undefined) {
    throw new MockerNotInstalledError(config.path);
  }
  host.log('[COMPILE] Building mocks (compact-mock)');
  let exit: number | string;
  try {
    exit = await host.run(
      mocker.command,
      [...mocker.args, ...mockBuildArgs(options, config.path)],
      host.cwd,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MockBuildError(`cannot run ${mocker.command}: ${reason}`);
  }
  if (exit !== 0) {
    throw new MockBuildError(
      typeof exit === 'number'
        ? `compact-mock exit ${exit}`
        : `compact-mock killed by ${exit}`,
    );
  }
  return compilerArgs;
}

/** The host `compact-compiler` runs with. */
export function nodeHost(log: (message: string) => void): MockBuildHost {
  return {
    cwd: process.cwd(),
    env: process.env,
    execPath: process.execPath,
    isFile: (path) =>
      statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
    isDirectory: (path) =>
      statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
    readFile: (path) => readFileSync(path, 'utf8'),
    resolvePackageJson: (cwd, name) => {
      try {
        return createRequire(join(cwd, 'package.json')).resolve(
          `${name}/package.json`,
        );
      } catch {
        return undefined;
      }
    },
    run: (command, args, cwd) =>
      new Promise((resolveExit, reject) => {
        const child = spawn(command, args, { cwd, stdio: 'inherit' });
        child.once('error', reject);
        child.once('close', (code, signal) =>
          resolveExit(code ?? signal ?? 'an unknown signal'),
        );
      }),
    log,
  };
}
