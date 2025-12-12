import { exec as execCallback, spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_OUT_DIR, DEFAULT_SRC_DIR } from '../config.ts';
import type {
  CircuitInfo,
  ContractMetadata,
} from '../types/benchmark.ts';
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
  /** Show detailed compiler output (circuit progress, etc.) */
  verbose?: boolean;
  /** Whether to capture output for parsing circuit details (needed for benchmarks) */
  captureOutput?: boolean;
}

/** Resolved options for CompilerService with defaults applied */
type ResolvedCompilerServiceOptions = Required<CompilerServiceOptions>;

/**
 * Result of compiling a file, including raw output and parsed metadata.
 */
export interface CompileResult {
  /** Raw stdout from the compiler */
  stdout: string;
  /** Raw stderr from the compiler */
  stderr: string;
  /** Parsed contract metadata (type and circuits) */
  metadata: ContractMetadata;
}

/**
 * Regex pattern to match circuit information in compiler output.
 * Matches lines like: `  circuit "gt" (k=12, rows=2639)`
 */
const CIRCUIT_PATTERN = /circuit\s+"([^"]+)"\s+\(k=(\d+),\s*rows=(\d+)\)/g;

/**
 * Parses circuit information from compiler output.
 * Extracts circuit names, k values, and row counts.
 *
 * @param output - The compiler stdout/stderr output
 * @returns Array of CircuitInfo objects, empty if no circuits found
 * @example
 * ```typescript
 * const output = `Compiling 2 circuits:
 *   circuit "gt" (k=12, rows=2639)
 *   circuit "gte" (k=12, rows=2643)
 * Overall progress [====================] 2/2`;
 *
 * const circuits = parseCircuitInfo(output);
 * // Returns: [{ name: "gt", k: 12, rows: 2639 }, { name: "gte", k: 12, rows: 2643 }]
 * ```
 */
export function parseCircuitInfo(output: string): CircuitInfo[] {
  // Use a Map to deduplicate circuits by name (spinner animation can cause duplicates)
  const circuitMap = new Map<string, CircuitInfo>();

  // Reset regex state for multiple calls
  CIRCUIT_PATTERN.lastIndex = 0;

  for (
    let match = CIRCUIT_PATTERN.exec(output);
    match !== null;
    match = CIRCUIT_PATTERN.exec(output)
  ) {
    const name = match[1];
    // Only add if not already seen (first occurrence wins)
    if (!circuitMap.has(name)) {
      circuitMap.set(name, {
        name,
        k: Number.parseInt(match[2], 10),
        rows: Number.parseInt(match[3], 10),
      });
    }
  }

  return Array.from(circuitMap.values());
}

/**
 * Determines contract metadata from compiler output.
 * A contract is 'top-level' if it has circuits, 'module' otherwise.
 *
 * @param output - The compiler stdout/stderr output
 * @returns ContractMetadata with type and optional circuits
 */
export function parseContractMetadata(output: string): ContractMetadata {
  const circuits = parseCircuitInfo(output);

  if (circuits.length > 0) {
    return {
      type: 'top-level',
      circuits,
    };
  }

  return {
    type: 'module',
  };
}

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
  private useSpawn: boolean;

  /**
   * Creates a new CompilerService instance.
   *
   * @param execFn - Function to execute shell commands (defaults to promisified child_process.exec)
   * @param options - Compiler service options
   */
  constructor(
    execFn?: ExecFunction,
    options: CompilerServiceOptions = {},
  ) {
    // If no custom execFn provided, use spawn for real compilation (streams output)
    // If custom execFn provided (testing), use that instead
    this.useSpawn = execFn === undefined;
    this.execFn = execFn ?? promisify(execCallback);
    this.options = {
      hierarchical: options.hierarchical ?? false,
      srcDir: options.srcDir ?? DEFAULT_SRC_DIR,
      outDir: options.outDir ?? DEFAULT_OUT_DIR,
      verbose: options.verbose ?? false,
      captureOutput: options.captureOutput ?? false,
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
   * @returns Promise resolving to compilation output with parsed metadata
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
   *   console.log('Contract type:', result.metadata.type);
   *   if (result.metadata.circuits) {
   *     console.log('Circuits:', result.metadata.circuits);
   *   }
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
  ): Promise<CompileResult> {
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
    const baseCommand = `compact compile${versionFlag ? ` ${versionFlag}` : ''}${flagsStr} "${inputPath}" "${outputDir}"`;

    // For testing, use the provided exec function directly
    if (!this.useSpawn) {
      try {
        const { stdout, stderr } = await this.execFn(baseCommand);
        const combinedOutput = `${stdout}\n${stderr}`;
        const metadata = parseContractMetadata(combinedOutput);
        return { stdout, stderr, metadata };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CompilationError(
          `Failed to compile ${file}: ${message}`,
          file,
          error,
        );
      }
    }

    // Build command arguments for spawn
    const args: string[] = ['compile'];
    if (versionFlag) {
      args.push(versionFlag);
    }
    for (const flag of flags) {
      args.push(flag);
    }
    args.push(inputPath, outputDir);

    // When capturing output for benchmarks, use 'script' command to create PTY
    // This properly captures animated progress bar output (circuit details)
    if (this.options.captureOutput) {
      const baseCommand = `compact ${args.join(' ')}`;
      let wrapperCommand: string;
      let wrapperArgs: string[];

      if (process.platform === 'darwin') {
        // macOS: script -q /dev/null sh -c "command"
        wrapperCommand = 'script';
        wrapperArgs = ['-q', '/dev/null', 'sh', '-c', baseCommand];
      } else {
        // Linux: script -q -c "command" /dev/null
        wrapperCommand = 'script';
        wrapperArgs = ['-q', '-c', baseCommand, '/dev/null'];
      }

      return new Promise((resolve, reject) => {
        const child = spawn(wrapperCommand, wrapperArgs, {
          stdio: ['inherit', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;
          // Show output since verbose is enabled when capturing
          process.stdout.write(chunk);
        });

        child.stderr?.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderr += chunk;
          // Show output since verbose is enabled when capturing
          process.stderr.write(chunk);
        });

        child.on('close', async (code) => {
          if (code === 0) {
            const combinedOutput = `${stdout}\n${stderr}`;
            const metadata = parseContractMetadata(combinedOutput);
            resolve({ stdout, stderr, metadata });
          } else {
            reject(
              new CompilationError(
                `Failed to compile ${file}: exit code ${code}`,
                file,
                new Error(stderr || stdout || `Compilation failed with exit code ${code}`),
              ),
            );
          }
        });

        child.on('error', (error) => {
          reject(
            new CompilationError(
              `Failed to compile ${file}: ${error.message}`,
              file,
              error,
            ),
          );
        });
      });
    }

    // Use spawn with stdio based on verbose option
    // - verbose: inherit stdio to show full animated output
    // - quiet: ignore stdio for cleaner output
    return new Promise((resolve, reject) => {
      const child = spawn('compact', args, {
        stdio: this.options.verbose ? 'inherit' : 'ignore',
      });

      child.on('close', async (code) => {
        if (code === 0) {
          // Check if compiled output contains circuits by looking for keys directory
          // Top-level contracts have circuit keys, modules don't
          const keysDir = join(outputDir, 'keys');
          const { existsSync } = await import('node:fs');
          const isTopLevel = existsSync(keysDir);
          const metadata: ContractMetadata = isTopLevel
            ? { type: 'top-level' }
            : { type: 'module' };
          resolve({ stdout: '', stderr: '', metadata });
        } else {
          reject(
            new CompilationError(
              `Failed to compile ${file}: exit code ${code}`,
              file,
              new Error(`Compilation failed with exit code ${code}`),
            ),
          );
        }
      });

      child.on('error', (error) => {
        reject(
          new CompilationError(
            `Failed to compile ${file}: ${error.message}`,
            file,
            error,
          ),
        );
      });
    });
  }
}
