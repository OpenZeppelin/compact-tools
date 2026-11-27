/**
 * The `compact-mock build` step `compact-compiler` runs before compiling when the nearest
 * `compact.toml` has a `[mock]` table.
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

/** Keeps generated mock sources and fragments out of the compiler's own walk. */
export const MOCK_EXCLUDES: readonly string[] = [
  '--exclude',
  '*/artifacts/*',
  '--exclude',
  '*.fragment.compact',
];

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

/** Whether the file parses as TOML and has a top-level `mock` table. */
export function hasMockTable(
  path: string,
  host: Pick<MockBuildHost, 'readFile'>,
): boolean {
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
  return (
    typeof mock === 'object' &&
    mock !== null &&
    !Array.isArray(mock) &&
    !(mock instanceof Date)
  );
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

/** `build` arguments: only the toolchain version, `--skip-zk`, the scope and the config. */
export function mockBuildArgs(
  options: CompilerOptions,
  configPath: string,
): string[] {
  const args = ['build'];
  if (options.version) {
    args.push(`+${options.version}`);
  }
  if ((options.flags ?? '').split(/\s+/).includes('--skip-zk')) {
    args.push('--skip-zk');
  }
  args.push('--dir', searchDir(options), '--config', configPath);
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

  const configPath = findCompactToml(host.cwd, host);
  if (configPath === undefined || !hasMockTable(configPath, host)) {
    return args;
  }

  const compilerArgs = [...args, ...MOCK_EXCLUDES];
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
    throw new MockerNotInstalledError(configPath);
  }
  host.log('[COMPILE] Building mocks (compact-mock)');
  let exit: number | string;
  try {
    exit = await host.run(
      mocker.command,
      [...mocker.args, ...mockBuildArgs(options, configPath)],
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
