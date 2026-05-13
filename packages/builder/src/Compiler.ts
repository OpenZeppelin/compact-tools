#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import { CompilerService } from './services/CompilerService.ts';
import { EnvironmentValidator } from './services/EnvironmentValidator.ts';
import { FileDiscovery } from './services/FileDiscovery.ts';
import { UIService } from './services/UIService.ts';
import {
  CompilationError,
  DirectoryNotFoundError,
  isPromisifiedChildProcessError,
} from './types/errors.ts';
import {
  type CompilerOptions,
  type CompilerServiceOptions,
  DEFAULT_OUT_DIR,
  DEFAULT_SRC_DIR,
  type ExecFunction,
} from './types/options.ts';

// Re-export public types and services so consumers keep importing them
// from './Compiler.js' regardless of the internal file layout.
// biome-ignore lint/performance/noBarrelFile: package entrypoint
export { CompilerService } from './services/CompilerService.ts';
export { EnvironmentValidator } from './services/EnvironmentValidator.ts';
export { FileDiscovery } from './services/FileDiscovery.ts';
export { UIService } from './services/UIService.ts';
export type { CompilerOptions, CompilerServiceOptions, ExecFunction };

/** Resolved compiler options with defaults applied */
type ResolvedCompilerOptions = Required<
  Pick<
    CompilerOptions,
    'flags' | 'hierarchical' | 'srcDir' | 'outDir' | 'exclude'
  >
> &
  Pick<CompilerOptions, 'targetDir' | 'version'>;

/**
 * Main compiler class that orchestrates the compilation process.
 * Coordinates environment validation, file discovery, and compilation services
 * to provide a complete .compact file compilation solution.
 *
 * Features:
 * - Dependency injection for testability
 * - Structured error propagation with custom error types
 * - Progress reporting and user feedback
 * - Support for compiler flags and toolchain versions
 * - Environment variable integration
 * - Configurable artifact output structure (flattened or hierarchical)
 *
 * @example
 * ```typescript
 * // Basic usage with options object (flattened artifacts by default)
 * const compiler = new CompactCompiler({
 *   flags: '--skip-zk',
 *   targetDir: 'security',
 *   version: '0.26.0',
 * });
 * await compiler.compile();
 *
 * // Factory method usage
 * const compiler = CompactCompiler.fromArgs(['--dir', 'security', '--skip-zk']);
 * await compiler.compile();
 *
 * // With hierarchical artifacts structure
 * const compiler = CompactCompiler.fromArgs(['--hierarchical', '--skip-zk']);
 * await compiler.compile();
 *
 * // With environment variables
 * process.env.SKIP_ZK = 'true';
 * const compiler = CompactCompiler.fromArgs(['--dir', 'token']);
 * await compiler.compile();
 * ```
 */
export class CompactCompiler {
  /** Environment validation service */
  private readonly environmentValidator: EnvironmentValidator;
  /** File discovery service */
  private readonly fileDiscovery: FileDiscovery;
  /** Compilation execution service */
  private readonly compilerService: CompilerService;
  /** Compiler options */
  private readonly options: ResolvedCompilerOptions;

  /**
   * Creates a new CompactCompiler instance with specified configuration.
   *
   * @param options - Compiler configuration options
   * @param execFn  - Optional custom exec function for dependency injection
   */
  constructor(options: CompilerOptions = {}, execFn?: ExecFunction) {
    this.options = {
      flags: (options.flags ?? '').trim(),
      targetDir: options.targetDir,
      version: options.version,
      hierarchical: options.hierarchical ?? false,
      srcDir: options.srcDir ?? DEFAULT_SRC_DIR,
      outDir: options.outDir ?? DEFAULT_OUT_DIR,
      exclude: options.exclude ?? [],
    };
    this.environmentValidator = new EnvironmentValidator(execFn);
    this.fileDiscovery = new FileDiscovery(
      this.options.srcDir,
      this.options.exclude,
    );
    this.compilerService = new CompilerService(execFn, {
      hierarchical: this.options.hierarchical,
      srcDir: this.options.srcDir,
      outDir: this.options.outDir,
    });
  }

  /**
   * Parses command-line arguments into a CompilerOptions object.
   *
   * Supported argument patterns:
   * - `--dir <directory>` - Target specific subdirectory within srcDir
   * - `--src <directory>` - Source directory containing .compact files (default: 'src')
   * - `--out <directory>` - Output directory for artifacts (default: 'artifacts')
   * - `--hierarchical` - Preserve source directory structure in artifacts output
   * - `--exclude <pattern>` - Skip `.compact` files matching the glob pattern (repeatable)
   * - `+<version>` - Use specific toolchain version
   * - Other arguments - Treated as compiler flags
   * - `SKIP_ZK=true` environment variable - Adds --skip-zk flag
   *
   * @param args - Array of command-line arguments
   * @param env  - Environment variables (defaults to process.env)
   * @returns Parsed CompilerOptions object
   * @throws {Error} If --dir, --src, --out, or --exclude is provided without a value
   */
  static parseArgs(
    args: string[],
    env: typeof process.env = process.env,
  ): CompilerOptions {
    const options: CompilerOptions = {
      hierarchical: false,
    };
    const flags: string[] = [];

    if (env.SKIP_ZK === 'true') {
      flags.push('--skip-zk');
    }

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--dir') {
        const valueExists =
          i + 1 < args.length && !args[i + 1].startsWith('--');
        if (valueExists) {
          options.targetDir = args[i + 1];
          i++;
        } else {
          throw new Error('--dir flag requires a directory name');
        }
      } else if (args[i] === '--src') {
        const valueExists =
          i + 1 < args.length && !args[i + 1].startsWith('--');
        if (valueExists) {
          options.srcDir = args[i + 1];
          i++;
        } else {
          throw new Error('--src flag requires a directory path');
        }
      } else if (args[i] === '--out') {
        const valueExists =
          i + 1 < args.length && !args[i + 1].startsWith('--');
        if (valueExists) {
          options.outDir = args[i + 1];
          i++;
        } else {
          throw new Error('--out flag requires a directory path');
        }
      } else if (args[i] === '--hierarchical') {
        options.hierarchical = true;
      } else if (args[i] === '--exclude') {
        const valueExists =
          i + 1 < args.length && !args[i + 1].startsWith('--');
        if (valueExists) {
          options.exclude ??= [];
          options.exclude.push(args[i + 1]);
          i++;
        } else {
          throw new Error('--exclude flag requires a pattern');
        }
      } else if (args[i].startsWith('+')) {
        options.version = args[i].slice(1);
      } else {
        // Forward flags in original order, no dedup — repeatable flags
        // (e.g. `--define x=1 --define y=2`) must be preserved as given.
        flags.push(args[i]);
      }
    }

    options.flags = flags.join(' ');
    return options;
  }

  /**
   * Factory method to create a CompactCompiler from command-line arguments.
   * See {@link CompactCompiler.parseArgs} for the supported argument shapes.
   *
   * @param args - Array of command-line arguments
   * @param env  - Environment variables (defaults to process.env)
   * @returns New CompactCompiler instance configured from arguments
   * @throws {Error} If --dir, --src, --out, or --exclude is provided without a value
   */
  static fromArgs(
    args: string[],
    env: typeof process.env = process.env,
  ): CompactCompiler {
    const options = CompactCompiler.parseArgs(args, env);
    return new CompactCompiler(options);
  }

  /**
   * Validates the compilation environment and displays version information.
   *
   * @throws {CompactCliNotFoundError} If Compact CLI is not available in PATH
   * @throws {Error} If version retrieval or other validation steps fail
   */
  async validateEnvironment(): Promise<void> {
    const { devToolsVersion, toolchainVersion } =
      await this.environmentValidator.validate(this.options.version);
    UIService.displayEnvInfo(
      devToolsVersion,
      toolchainVersion,
      this.options.targetDir,
      this.options.version,
    );
  }

  /**
   * Main compilation method that orchestrates the entire compilation process.
   *
   * @throws {CompactCliNotFoundError} If Compact CLI is not available
   * @throws {DirectoryNotFoundError} If target directory doesn't exist
   * @throws {CompilationError} If any file compilation fails
   */
  async compile(): Promise<void> {
    await this.validateEnvironment();

    const searchDir = this.options.targetDir
      ? join(this.options.srcDir, this.options.targetDir)
      : this.options.srcDir;

    // Validate target directory exists
    if (this.options.targetDir && !existsSync(searchDir)) {
      throw new DirectoryNotFoundError(
        `Target directory ${searchDir} does not exist`,
        searchDir,
      );
    }

    const compactFiles = await this.fileDiscovery.getCompactFiles(searchDir);

    if (compactFiles.length === 0) {
      UIService.showNoFiles(this.options.targetDir);
      return;
    }

    UIService.showCompilationStart(compactFiles.length, this.options.targetDir);

    for (const [index, file] of compactFiles.entries()) {
      await this.compileFile(file, index, compactFiles.length);
    }
  }

  /**
   * Compiles a single file with progress reporting and error handling.
   *
   * @param file  - Relative path to the .compact file
   * @param index - Current file index (0-based) for progress tracking
   * @param total - Total number of files being compiled
   * @throws {CompilationError} If compilation fails
   */
  private async compileFile(
    file: string,
    index: number,
    total: number,
  ): Promise<void> {
    const step = `[${index + 1}/${total}]`;
    const spinner = ora(
      chalk.blue(`[COMPILE] ${step} Compiling ${file}`),
    ).start();

    try {
      const result = await this.compilerService.compileFile(
        file,
        this.options.flags,
        this.options.version,
      );

      spinner.succeed(chalk.green(`[COMPILE] ${step} Compiled ${file}`));
      // Filter out compactc version output from compact compile
      const filteredOutput = result.stdout.split('\n').slice(1).join('\n');

      if (filteredOutput) {
        UIService.printOutput(filteredOutput, chalk.cyan);
      }
      UIService.printOutput(result.stderr, chalk.yellow);
    } catch (error) {
      spinner.fail(chalk.red(`[COMPILE] ${step} Failed ${file}`));

      // CompilationError wraps the underlying child-process error in `.cause`.
      // The previous guard `isPromisifiedChildProcessError(error)` on a
      // CompilationError instance was unreachable — unwrap via `.cause` to
      // surface compactc's stdout/stderr to the user.
      const execError = error instanceof CompilationError ? error.cause : error;
      if (isPromisifiedChildProcessError(execError)) {
        // Filter out compactc version output from compact compile
        const filteredOutput = execError.stdout.split('\n').slice(1).join('\n');

        if (filteredOutput) {
          UIService.printOutput(filteredOutput, chalk.cyan);
        }
        UIService.printOutput(execError.stderr, chalk.red);
      }

      throw error;
    }
  }

  /**
   * For testing - returns the resolved options object
   */
  get testOptions(): ResolvedCompilerOptions {
    return this.options;
  }
}
