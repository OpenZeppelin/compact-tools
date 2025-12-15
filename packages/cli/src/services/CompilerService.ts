import { execFile as execFileCallback } from 'node:child_process';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_OUT_DIR, DEFAULT_SRC_DIR } from '../config.ts';
import { CompilationError } from '../types/errors.ts';
import type { CompilerFlag } from '../types/manifest.ts';
import { FileDiscovery } from './FileDiscovery.ts';

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
 * Function type for executing commands with arguments array (non-shell execution).
 * Allows dependency injection for testing and customization.
 *
 * @param command - The command to execute (e.g., 'compact')
 * @param args - Array of command arguments
 * @returns Promise resolving to command output
 */
export type ExecFileFunction = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

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
 *   ['--skip-zk', '--trace-passes'],
 *   '0.26.0'
 * );
 * console.log('Compilation output:', result.stdout);
 * ```
 */
export class CompilerService {
  private execFileFn: ExecFileFunction;
  private options: ResolvedCompilerServiceOptions;
  private pathValidator: FileDiscovery;

  /**
   * Creates a new CompilerService instance.
   *
   * @param execFileFn - Function to execute commands with args array (defaults to promisified child_process.execFile)
   * @param options - Compiler service options
   * @param pathValidator - Optional FileDiscovery instance for path validation (creates new one if not provided)
   */
  constructor(
    execFileFn?: ExecFileFunction,
    options: CompilerServiceOptions = {},
    pathValidator?: FileDiscovery,
  ) {
    // Default to promisified execFile for safe non-shell execution
    this.execFileFn =
      execFileFn ??
      ((command: string, args: string[]) =>
        promisify(execFileCallback)(command, args));
    this.options = {
      hierarchical: options.hierarchical ?? false,
      srcDir: options.srcDir ?? DEFAULT_SRC_DIR,
      outDir: options.outDir ?? DEFAULT_OUT_DIR,
    };
    // Use FileDiscovery for path validation (defense in depth - paths should already be validated during discovery)
    this.pathValidator =
      pathValidator ?? new FileDiscovery(this.options.srcDir);
  }

  /**
   * Compiles a single .compact file using the Compact CLI.
   * Constructs the appropriate command with flags and version, then executes it.
   *
   * By default, uses flattened output structure where all artifacts go to `<outDir>/<ContractName>/`.
   * When `hierarchical` is true, preserves source directory structure: `<outDir>/<subdir>/<ContractName>/`.
   *
   * @param file - Relative path to the .compact file from srcDir
   * @param flags - Array of compiler flags (e.g., ['--skip-zk', '--trace-passes'])
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

    // Validate and normalize input path to prevent command injection
    const validatedInputPath = this.pathValidator.validateAndNormalizePath(
      inputPath,
      this.options.srcDir,
    );

    // Normalize output directory path (no need to validate existence, it will be created)
    const normalizedOutputDir = normalize(resolve(outputDir));

    // Construct args array for execFile (non-shell execution)
    const args: string[] = ['compile'];

    // Add version flag if specified
    if (version) {
      args.push(`+${version}`);
    }

    // Add compiler flags
    args.push(...flags);

    // Add input and output paths
    args.push(validatedInputPath, normalizedOutputDir);

    try {
      return await this.execFileFn('compact', args);
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
