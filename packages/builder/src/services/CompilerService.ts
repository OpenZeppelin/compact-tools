import { execFile as execFileCallback } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseShellArgs } from 'shell-quote';
import { CompilationError } from '../types/errors.ts';
import {
  type CompilerServiceOptions,
  DEFAULT_OUT_DIR,
  DEFAULT_SRC_DIR,
  type ExecFunction,
} from '../types/options.ts';

/** Resolved options for CompilerService with defaults applied */
type ResolvedCompilerServiceOptions = Required<CompilerServiceOptions>;

const defaultExecFn: ExecFunction = (file, args) =>
  promisify(execFileCallback)(file, [...args]);

/**
 * Tokenizes a user-supplied `flags` string into discrete argv entries using
 * `shell-quote` (the same rules a shell would apply for splitting). Any
 * non-string tokens (e.g. operators like `;`, `&&`) are filtered out so they
 * cannot leak into argv as data — defense in depth against command injection
 * via the `flags` option.
 */
function tokenizeFlags(flags: string): string[] {
  if (!flags) {
    return [];
  }
  return parseShellArgs(flags).filter(
    (token): token is string => typeof token === 'string',
  );
}

/**
 * Service responsible for compiling individual .compact files.
 * Builds argv arrays and invokes the Compact CLI via `child_process.execFile`
 * (no shell), so user-supplied values cannot inject extra commands.
 *
 * @example
 * ```typescript
 * const compiler = new CompilerService();
 * const result = await compiler.compileFile(
 *   'contracts/Token.compact',
 *   '--skip-zk --verbose',
 *   '0.26.0'
 * );
 * ```
 */
export class CompilerService {
  private execFn: ExecFunction;
  private options: ResolvedCompilerServiceOptions;

  /**
   * Creates a new CompilerService instance.
   *
   * @param execFn  - Function to invoke the Compact CLI binary (defaults to
   *                  a promisified `child_process.execFile` — argv array, no shell).
   * @param options - Compiler service options
   */
  constructor(
    execFn: ExecFunction = defaultExecFn,
    options: CompilerServiceOptions = {},
  ) {
    this.execFn = execFn;
    this.options = {
      hierarchical: options.hierarchical ?? false,
      srcDir: options.srcDir ?? DEFAULT_SRC_DIR,
      outDir: options.outDir ?? DEFAULT_OUT_DIR,
    };
  }

  /**
   * Compiles a single .compact file using the Compact CLI.
   * Builds the argv array (no shell interpolation) and invokes the binary.
   *
   * By default, uses flattened output structure where all artifacts go to `<outDir>/<ContractName>/`.
   * When `hierarchical` is true, preserves source directory structure: `<outDir>/<subdir>/<ContractName>/`.
   *
   * @param file    - Relative path to the .compact file from srcDir
   * @param flags   - Space-separated compiler flags (e.g., '--skip-zk --verbose').
   *                  Tokenized via `shell-quote` so quoted whitespace is preserved
   *                  and shell operators (`;`, `&&`, …) cannot inject commands.
   * @param version - Optional specific toolchain version to use
   * @returns Promise resolving to compilation output (stdout/stderr)
   * @throws {CompilationError} If compilation fails for any reason
   */
  async compileFile(
    file: string,
    flags: string,
    version?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const inputPath = join(this.options.srcDir, file);
    const fileDir = dirname(file);
    const fileName = basename(file, '.compact');

    // Flattened (default): <outDir>/<ContractName>/
    // Hierarchical: <outDir>/<subdir>/<ContractName>/
    const outputDir =
      this.options.hierarchical && fileDir !== '.'
        ? join(this.options.outDir, fileDir, fileName)
        : join(this.options.outDir, fileName);

    const args: string[] = [
      'compile',
      ...(version ? [`+${version}`] : []),
      ...tokenizeFlags(flags),
      inputPath,
      outputDir,
    ];

    try {
      return await this.execFn('compact', args);
    } catch (error: unknown) {
      let message: string;

      if (error instanceof Error) {
        message = error.message;
      } else {
        message = String(error); // fallback for strings, objects, numbers, etc.
      }

      throw new CompilationError(
        `Failed to compile ${file}: ${message}`,
        file,
        error,
      );
    }
  }
}
