#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import {
  type CompactcVersion,
  type CompactToolVersion,
  DEFAULT_OUT_DIR,
  DEFAULT_SRC_DIR,
} from './config.ts';
import { CompilerService } from './services/CompilerService.ts';
import {
  EnvironmentValidator,
  type ExecFunction,
} from './services/EnvironmentValidator.ts';
import { FileDiscovery } from './services/FileDiscovery.ts';
import { ManifestService } from './services/ManifestService.ts';
import { UIService } from './services/UIService.ts';
import {
  CompilationError,
  DirectoryNotFoundError,
  isPromisifiedChildProcessError,
} from './types/errors.ts';
import {
  type CompilerFlag,
  type HierarchicalArtifactNode,
  type HierarchicalArtifacts,
  type NodeVersion,
  type Platform,
  StructureMismatchError,
} from './types/manifest.ts';

/**
 * Configuration options for the Compact compiler CLI.
 *
 * @interface CompilerOptions
 * @example
 * ```typescript
 * const options: CompilerOptions = {
 *   flags: ['--skip-zk'],
 *   targetDir: 'security',
 *   version: '0.26.0',
 *   hierarchical: false,
 * };
 * ```
 */
export interface CompilerOptions {
  /** Compiler flags to pass to the Compact CLI */
  flags?: CompilerFlag[];
  /** Optional subdirectory within srcDir to compile (e.g., 'security', 'token') */
  targetDir?: string;
  /** Optional compactc toolchain version to use */
  version?: CompactcVersion;
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
   * Force deletion of existing artifacts on structure mismatch.
   * When true, skips the confirmation prompt and auto-deletes.
   */
  force?: boolean;
}

/** Resolved compiler options with defaults applied */
type ResolvedCompilerOptions = Required<
  Pick<
    CompilerOptions,
    'flags' | 'hierarchical' | 'srcDir' | 'outDir' | 'force'
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
 * @class CompactCompiler
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
  /** Manifest management service */
  private readonly manifestService: ManifestService;
  /** Compiler options */
  private readonly options: ResolvedCompilerOptions;

  /**
   * Creates a new CompactCompiler instance with specified configuration.
   *
   * @param options - Compiler configuration options
   * @param execFn - Optional custom exec function for dependency injection
   * @example
   * ```typescript
   * // Compile all files with flags (flattened artifacts)
   * const compiler = new CompactCompiler({ flags: '--skip-zk --verbose' });
   *
   * // Compile specific directory
   * const compiler = new CompactCompiler({ targetDir: 'security' });
   *
   * // Compile with specific version
   * const compiler = new CompactCompiler({ flags: '--skip-zk', version: '0.26.0' });
   *
   * // Compile with hierarchical artifacts structure
   * const compiler = new CompactCompiler({ flags: '--skip-zk', hierarchical: true });
   *
   * // For testing with custom exec function
   * const mockExec = vi.fn();
   * const compiler = new CompactCompiler({}, mockExec);
   * ```
   */
  constructor(options: CompilerOptions = {}, execFn?: ExecFunction) {
    this.options = {
      flags: options.flags ?? [],
      targetDir: options.targetDir,
      version: options.version,
      hierarchical: options.hierarchical ?? false,
      srcDir: options.srcDir ?? DEFAULT_SRC_DIR,
      outDir: options.outDir ?? DEFAULT_OUT_DIR,
      force: options.force ?? false,
    };
    this.environmentValidator = new EnvironmentValidator(execFn);
    this.fileDiscovery = new FileDiscovery(this.options.srcDir);
    this.compilerService = new CompilerService(execFn, {
      hierarchical: this.options.hierarchical,
      srcDir: this.options.srcDir,
      outDir: this.options.outDir,
    });
    this.manifestService = new ManifestService(this.options.outDir);
  }

  /**
   * Parses command-line arguments into a CompilerOptions object.
   *
   * Supported argument patterns:
   * - `--dir <directory>` - Target specific subdirectory within srcDir
   * - `--src <directory>` - Source directory containing .compact files (default: 'src')
   * - `--out <directory>` - Output directory for artifacts (default: 'artifacts')
   * - `--hierarchical` - Preserve source directory structure in artifacts output
   * - `+<version>` - Use specific toolchain version
   * - Other arguments - Treated as compiler flags
   * - `SKIP_ZK=true` environment variable - Adds --skip-zk flag
   *
   * @param args - Array of command-line arguments
   * @param env - Environment variables (defaults to process.env)
   * @returns Parsed CompilerOptions object
   * @throws {Error} If --dir, --src, or --out flag is provided without a value
   */
  static parseArgs(
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
  ): CompilerOptions {
    const options: CompilerOptions = {
      hierarchical: false,
      force: false,
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
      } else if (args[i] === '--force' || args[i] === '-f') {
        options.force = true;
      } else if (args[i].startsWith('+')) {
        options.version = args[i].slice(1) as CompactcVersion;
      } else {
        // Only add flag if it's not already present
        if (!flags.includes(args[i])) {
          flags.push(args[i]);
        }
      }
    }

    options.flags = flags as CompilerFlag[];
    return options;
  }

  /**
   * Factory method to create a CompactCompiler from command-line arguments.
   * Parses various argument formats including flags, directories, versions, and environment variables.
   *
   * Supported argument patterns:
   * - `--dir <directory>` - Target specific subdirectory within srcDir
   * - `--src <directory>` - Source directory containing .compact files (default: 'src')
   * - `--out <directory>` - Output directory for artifacts (default: 'artifacts')
   * - `--hierarchical` - Preserve source directory structure in artifacts output
   * - `+<version>` - Use specific toolchain version
   * - Other arguments - Treated as compiler flags
   * - `SKIP_ZK=true` environment variable - Adds --skip-zk flag
   *
   * @param args - Array of command-line arguments
   * @param env - Environment variables (defaults to process.env)
   * @returns New CompactCompiler instance configured from arguments
   * @throws {Error} If --dir, --src, or --out flag is provided without a value
   * @example
   * ```typescript
   * // Parse command line: compact-compiler --dir security --skip-zk +0.26.0
   * const compiler = CompactCompiler.fromArgs([
   *   '--dir', 'security',
   *   '--skip-zk',
   *   '+0.26.0'
   * ]);
   *
   * // With custom source and output directories
   * const compiler = CompactCompiler.fromArgs([
   *   '--src', 'contracts',
   *   '--out', 'build/artifacts',
   *   '--skip-zk'
   * ]);
   *
   * // With hierarchical artifacts structure
   * const compiler = CompactCompiler.fromArgs([
   *   '--hierarchical',
   *   '--skip-zk'
   * ]);
   *
   * // With environment variable
   * const compiler = CompactCompiler.fromArgs(
   *   ['--dir', 'token'],
   *   { SKIP_ZK: 'true' }
   * );
   *
   * // Empty args with environment
   * const compiler = CompactCompiler.fromArgs([], { SKIP_ZK: 'true' });
   * ```
   */
  static fromArgs(
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
  ): CompactCompiler {
    const options = CompactCompiler.parseArgs(args, env);
    return new CompactCompiler(options);
  }

  /**
   * Validates the compilation environment and displays version information.
   * Performs environment validation, retrieves toolchain versions, and shows configuration details.
   *
   * Process:
   *
   * 1. Validates CLI availability and toolchain compatibility
   * 2. Retrieves developer tools and compiler versions
   * 3. Displays environment configuration information
   *
   * @throws {CompactCliNotFoundError} If Compact CLI is not available in PATH
   * @throws {Error} If version retrieval or other validation steps fail
   * @example
   * ```typescript
   * try {
   *   await compiler.validateEnvironment();
   *   console.log('Environment ready for compilation');
   * } catch (error) {
   *   if (error instanceof CompactCliNotFoundError) {
   *     console.error('Please install Compact CLI');
   *   }
   * }
   * ```
   */
  async validateEnvironment(): Promise<{
    compactToolVersion: CompactToolVersion;
    compactcVersion: CompactcVersion;
  }> {
    const { compactToolVersion, compactcVersion } =
      await this.environmentValidator.validate(this.options.version);
    UIService.displayEnvInfo(
      compactToolVersion,
      compactcVersion,
      this.options.targetDir,
      this.options.version,
    );
    return { compactToolVersion, compactcVersion };
  }

  /**
   * Main compilation method that orchestrates the entire compilation process.
   *
   * Process flow:
   * 1. Validates environment and shows configuration
   * 2. Discovers .compact files in target directory
   * 3. Compiles each file with progress reporting
   * 4. Handles errors and provides user feedback
   *
   * @throws {CompactCliNotFoundError} If Compact CLI is not available
   * @throws {DirectoryNotFoundError} If target directory doesn't exist
   * @throws {CompilationError} If any file compilation fails
   * @example
   * ```typescript
   * const compiler = new CompactCompiler('--skip-zk', 'security');
   *
   * try {
   *   await compiler.compile();
   *   console.log('All files compiled successfully');
   * } catch (error) {
   *   if (error instanceof DirectoryNotFoundError) {
   *     console.error(`Directory not found: ${error.directory}`);
   *   } else if (error instanceof CompilationError) {
   *     console.error(`Failed to compile: ${error.file}`);
   *   }
   * }
   * ```
   */
  async compile(): Promise<void> {
    const startTime = Date.now();
    const { compactToolVersion, compactcVersion } =
      await this.validateEnvironment();

    // Check for structure mismatch
    const requestedStructure = this.options.hierarchical
      ? 'hierarchical'
      : 'flattened';
    const existingManifest =
      await this.manifestService.checkMismatch(requestedStructure);

    if (existingManifest) {
      if (this.options.force) {
        // Auto-clean with --force flag
        const spinner = ora();
        spinner.info(
          chalk.yellow(
            `[COMPILE] Cleaning existing "${existingManifest.structure}" artifacts (--force)`,
          ),
        );
        await this.manifestService.cleanOutputDirectory();
      } else {
        // Throw error to be handled by CLI for interactive prompt
        throw new StructureMismatchError(
          existingManifest.structure,
          requestedStructure,
        );
      }
    }

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

    // Track artifacts: hierarchical uses nested tree, flattened uses string[]
    const hierarchicalArtifacts: HierarchicalArtifacts = {};
    const flatArtifacts: string[] = [];

    for (const [index, file] of compactFiles.entries()) {
      await this.compileFile(file, index, compactFiles.length);

      if (requestedStructure === 'hierarchical') {
        this.addArtifactToTree(hierarchicalArtifacts, file);
      } else {
        flatArtifacts.push(basename(file, '.compact'));
      }
    }

    // Write manifest after successful compilation
    const buildDuration = Date.now() - startTime;

    // Get compiler flags (undefined if empty array)
    const compilerFlags =
      this.options.flags.length > 0 ? this.options.flags : undefined;

    // Get Node.js major version
    const nodeVersion = process.version.match(/^v(\d+)/)?.[1] as
      | NodeVersion
      | undefined;

    // Get platform identifier
    const platform = `${process.platform}-${process.arch}` as Platform;

    await this.manifestService.write({
      structure: requestedStructure,
      compactcVersion: compactcVersion as CompactcVersion,
      compactToolVersion: compactToolVersion as CompactToolVersion,
      createdAt: new Date().toISOString(),
      buildDuration,
      nodeVersion,
      platform,
      sourcePath: this.options.srcDir,
      outputPath: this.options.outDir,
      compilerFlags,
      artifacts:
        requestedStructure === 'hierarchical'
          ? hierarchicalArtifacts
          : flatArtifacts,
    });
  }

  /**
   * Compiles a single file with progress reporting and error handling.
   * Private method used internally by the main compile() method.
   *
   * @param file - Relative path to the .compact file
   * @param index - Current file index (0-based) for progress tracking
   * @param total - Total number of files being compiled
   * @throws {CompilationError} If compilation fails
   * @private
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

      if (
        error instanceof CompilationError &&
        isPromisifiedChildProcessError(error)
      ) {
        const execError = error;
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
   * Cleans the output directory by removing all artifacts.
   * Used when user confirms deletion after structure mismatch.
   */
  async cleanOutputDirectory(): Promise<void> {
    await this.manifestService.cleanOutputDirectory();
  }

  /**
   * Compiles after cleaning the output directory.
   * Used when user confirms deletion after structure mismatch.
   */
  async cleanAndCompile(): Promise<void> {
    const spinner = ora();
    spinner.info(chalk.yellow('[COMPILE] Cleaning existing artifacts...'));
    await this.cleanOutputDirectory();
    await this.compile();
  }

  /**
   * For testing - returns the resolved options object
   */
  get testOptions(): ResolvedCompilerOptions {
    return this.options;
  }

  /**
   * Adds an artifact to the hierarchical tree structure.
   * Creates nested nodes as needed based on the file path.
   *
   * @param tree - The hierarchical artifacts tree to add to
   * @param file - The file path (e.g., 'math/test/Uint128.mock.compact')
   */
  private addArtifactToTree(tree: HierarchicalArtifacts, file: string): void {
    const artifactName = basename(file, '.compact');
    const subDir = dirname(file);

    if (subDir === '.') {
      // Root level artifacts go into a 'root' node
      if (!tree.root) {
        tree.root = { artifacts: [] };
      }
      (tree.root.artifacts as string[]).push(artifactName);
    } else {
      // Navigate/create nested structure
      const pathParts = subDir.split('/');
      let current: HierarchicalArtifactNode = tree;

      for (const part of pathParts) {
        if (!current[part]) {
          current[part] = { artifacts: [] };
        }
        current = current[part] as HierarchicalArtifactNode;
      }

      // Add artifact to the current node
      if (!current.artifacts) {
        current.artifacts = [];
      }
      (current.artifacts as string[]).push(artifactName);
    }
  }
}
