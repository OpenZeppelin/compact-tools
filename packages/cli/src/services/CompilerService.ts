import { exec as execCallback } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_OUT_DIR, DEFAULT_SRC_DIR } from '../config.ts';
import { CompilationError } from '../types/errors.ts';
import type { CompilerFlag } from '../types/manifest.ts';
import type { ExecFunction } from './EnvironmentValidator.ts';

/**
 * Options for configuring the CompilerService.
 */
export interface CompilerServiceOptions {
  /** Whether to use hierarchical output structure */
  hierarchical?: boolean;
  /** Source directory containing .compact files */
  srcDir?: string;
  /** Output directory for compiled artifacts */
  outDir?: string;
}

/** Resolved options for CompilerService with defaults applied */
type ResolvedCompilerServiceOptions = Required<CompilerServiceOptions>;

/**
 * Service responsible for compiling individual .compact files.
 * Handles command construction, execution, and error processing.
 *
 * @class CompilerService
 * @example
 * ```typescript
 * const compiler = new CompilerService();
 * const result = await compiler.compileFile(
 *   'contracts/Token.compact',
 *   ['--skip-zk', '--verbose'],
 *   '0.26.0'
 * );
 * console.log('Compilation output:', result.stdout);
 * ```
 */
export class CompilerService {
  private execFn: ExecFunction;
  private options: ResolvedCompilerServiceOptions;

  /**
   * Creates a new CompilerService instance.
   *
   * @param execFn - Function to execute shell commands (defaults to promisified child_process.exec)
   * @param options - Compiler service options
   */
  constructor(
    execFn: ExecFunction = promisify(execCallback),
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
   * Constructs the appropriate command with flags and version, then executes it.
   *
   * By default, uses flattened output structure where all artifacts go to `<outDir>/<ContractName>/`.
   * When `hierarchical` is true, preserves source directory structure: `<outDir>/<subdir>/<ContractName>/`.
   *
   * @param file - Relative path to the .compact file from srcDir
   * @param flags - Array of compiler flags (e.g., ['--skip-zk', '--verbose'])
   * @param version - Optional specific toolchain version to use
   * @returns Promise resolving to compilation output (stdout/stderr)
   * @throws {CompilationError} If compilation fails for any reason
   * @example
   * ```typescript
   * try {
   *   const result = await compiler.compileFile(
   *     'security/AccessControl.compact',
   *     ['--skip-zk'],
   *     '0.26.0'
   *   );
   *   console.log('Success:', result.stdout);
   * } catch (error) {
   *   if (error instanceof CompilationError) {
   *     console.error('Compilation failed for', error.file);
   *   }
   * }
   * ```
   */
  async compileFile(
    file: string,
    flags: CompilerFlag[],
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

    const versionFlag = version ? `+${version}` : '';
    const flagsStr = flags.length > 0 ? ` ${flags.join(' ')}` : '';
    const command = `compact compile${versionFlag ? ` ${versionFlag}` : ''}${flagsStr} "${inputPath}" "${outputDir}"`;

    try {
      return await this.execFn(command);
    } catch (error: unknown) {
      let message: string;

      if (error instanceof Error) {
        message = error.message;
      } else {
        message = String(error);
      }

      throw new CompilationError(
        `Failed to compile ${file}: ${message}`,
        file,
        error,
      );
    }
  }
}
