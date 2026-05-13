/**
 * Shared option/type definitions and defaults for the Compact CLI tools.
 *
 * This module is the canonical home for cross-cutting types (`CompilerOptions`,
 * `BuilderOptions`, `ExecFunction`, …) plus their default constants. Splitting
 * them out keeps `Compiler.ts` and `Builder.ts` focused on behaviour rather
 * than data shapes.
 */

/** Default source directory containing .compact files. */
export const DEFAULT_SRC_DIR = 'src';

/** Default output directory for compiled artifacts. */
export const DEFAULT_OUT_DIR = 'artifacts';

/**
 * Default `.compact` glob patterns the builder strips from `dist/` when the
 * user hasn't supplied an explicit `--exclude` list. Covers both common mock
 * naming conventions.
 */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  'Mock*',
  '*.mock.compact',
];

/**
 * Function type for executing a child process.
 *
 * Matches the shape of `promisify(child_process.execFile)`: the binary name
 * (no shell), followed by positional arguments. This signature is injection-
 * safe by construction — values flow as separate argv entries rather than
 * being interpolated into a shell command string.
 *
 * @param file - The binary to invoke (e.g. `'compact'`)
 * @param args - Positional arguments passed verbatim to the binary
 * @returns Promise resolving to the captured stdout/stderr
 */
export type ExecFunction = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Configuration options for the Compact compiler CLI.
 *
 * @example
 * ```typescript
 * const options: CompilerOptions = {
 *   flags: '--skip-zk --verbose',
 *   targetDir: 'security',
 *   version: '0.26.0',
 *   hierarchical: false,
 * };
 * ```
 */
export interface CompilerOptions {
  /** Compiler flags to pass to the Compact CLI (e.g., '--skip-zk --verbose') */
  flags?: string;
  /** Optional subdirectory within srcDir to compile (e.g., 'security', 'token') */
  targetDir?: string;
  /** Optional toolchain version to use (e.g., '0.26.0') */
  version?: string;
  /**
   * Whether to preserve directory structure in artifacts output.
   * - `false` (default): Flattened output - `<outDir>/<ContractName>/`
   * - `true`: Hierarchical output - `<outDir>/<subdir>/<ContractName>/`
   */
  hierarchical?: boolean;
  /** Source directory containing .compact files (default: 'src') */
  srcDir?: string;
  /** Output directory for compiled artifacts (default: 'artifacts') */
  outDir?: string;
  /**
   * Glob-style patterns to exclude `.compact` files from both the compiler's
   * file discovery and the builder's `.compact` copy step.
   * - Patterns without `/` match against the filename only (e.g. `'Mock*'`).
   * - Patterns with `/` match against the path as `find <srcDir>` would emit
   *   it (e.g. `'*\/archive\/*'`, matching `src/archive/Foo.compact`). This is
   *   the same semantic as `find -path '<pattern>'`.
   *
   * Default: `undefined` (no excludes for the compiler). The builder
   * substitutes its own default ({@link DEFAULT_EXCLUDE_PATTERNS}) when
   * undefined; pass an explicit `[]` to disable that too.
   */
  exclude?: string[];
}

/**
 * Subset of {@link CompilerOptions} consumed by `CompilerService` when
 * compiling individual files.
 */
export type CompilerServiceOptions = Pick<
  CompilerOptions,
  'hierarchical' | 'srcDir' | 'outDir'
>;

/**
 * Builder-only configuration options that don't apply to the compiler.
 *
 * These control the *distribution* layout produced by `compact-builder`,
 * letting consumers ship a publishable `dist/` directory matching their
 * package's conventions (e.g. copying metadata files for npm publish).
 *
 * Two inherited {@link CompilerOptions} fields also affect builder behaviour:
 * - `hierarchical` — drives both compiler artifacts layout AND `.compact` copy layout.
 * - `exclude`     — drives both compiler file discovery AND `.compact` copy filtering.
 *   When `exclude` is undefined, the builder substitutes its own default
 *   ({@link DEFAULT_EXCLUDE_PATTERNS}) so mocks are stripped from the dist
 *   even when the compiler is told to consume them.
 */
export interface BuilderOnlyOptions {
  /**
   * If true, runs `rm -rf dist && mkdir -p dist` before building.
   * Use when you want a fully clean `dist/` on every build.
   * @default false
   */
  cleanDist?: boolean;
  /**
   * Additional file paths to copy into `dist/` for distribution
   * (e.g. `['package.json', '../README.md']`). Paths are relative to cwd.
   * Each entry is copied individually with `cp <path> dist/`.
   * @default []
   */
  copyToDist?: string[];
}

/**
 * Configuration options for the Builder CLI.
 * Extends {@link CompilerOptions} with builder-only distribution controls.
 */
export type BuilderOptions = CompilerOptions & BuilderOnlyOptions;

/**
 * Single build step executed by `CompactBuilder`.
 */
export interface BuildStep {
  /** Shell command to execute. */
  cmd: string;
  /** Human-readable progress message. */
  msg: string;
  /** Optional explicit shell (e.g. `'/bin/bash'`) when bash features are required. */
  shell?: string;
}
