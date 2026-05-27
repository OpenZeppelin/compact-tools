import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
 * Spawn `compact` under a pseudo-terminal using the `script` command so that
 * `compactc` emits its full progress UI (circuit constraint lines with k/rows
 * values).
 *
 * Output is silenced by redirecting stdout/stderr to `/dev/null` file
 * descriptors. The `script` command still captures the full PTY output to
 * a temp file, which is read after the process exits.
 *
 * Handles both macOS and Linux `script` syntax:
 * - macOS: `script -q <file> <command> [args...]`
 * - Linux: `script -qc "<command> [args...]" <file>`
 *
 * Note: Circuit constraint output is only available when compiling WITHOUT
 * `--skip-zk`, as the k/rows values come from the ZK proving pass. When
 * `--skip-zk` is used, the returned stdout will contain only the
 * `Compiling N circuits:` header.
 */
async function spawnWithPty(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const tmpFile = join(tmpdir(), `compact-pty-${Date.now()}.txt`);
  const devNull = openSync('/dev/null', 'w');

  return new Promise((resolve, reject) => {
    let scriptArgs: string[];

    if (platform() === 'darwin') {
      // macOS: script -q <file> <command> [args...]
      scriptArgs = ['-q', tmpFile, 'compact', ...args];
    } else {
      // Linux: script -qc "<command>" <file>
      const cmd = ['compact', ...args]
        .map((a) => (a.includes(' ') ? `'${a}'` : a))
        .join(' ');
      scriptArgs = ['-qc', cmd, tmpFile];
    }

    const proc = spawn('script', scriptArgs, {
      stdio: ['ignore', devNull, devNull],
    });
    closeSync(devNull);

    proc.on('error', (err) => {
      try {
        unlinkSync(tmpFile);
      } catch {}
      reject(err);
    });

    proc.on('close', (code) => {
      let output = '';
      try {
        output = readFileSync(tmpFile, 'utf-8');
      } catch {}
      try {
        unlinkSync(tmpFile);
      } catch {}

      if (code !== 0) {
        const error = new Error(`compact exited with code ${code}`) as Error & {
          stdout: string;
          stderr: string;
        };
        error.stdout = output;
        error.stderr = '';
        reject(error);
      } else {
        resolve({ stdout: output, stderr: '' });
      }
    });
  });
}

/**
 * Service responsible for compiling individual .compact files.
 *
 * When no custom `execFn` is provided (production), spawns `compact` under a
 * pseudo-terminal via the `script` command so the full progress output
 * (including per-circuit constraint lines) is silently captured. The output
 * is written to a temp file, read after compilation, and cleaned up.
 *
 * When a custom `execFn` is injected (testing), uses that function instead,
 * preserving full testability without `script` or PTY.
 *
 * @example
 * ```typescript
 * // Production — uses script/PTY (silent capture)
 * const compiler = new CompilerService();
 *
 * // Testing — uses injected mock
 * const mockExec = vi.fn();
 * const compiler = new CompilerService(mockExec);
 * ```
 */
export class CompilerService {
  private execFn: ExecFunction | null;
  private options: ResolvedCompilerServiceOptions;

  /**
   * Creates a new CompilerService instance.
   *
   * @param execFn  - Optional exec function for dependency injection (testing).
   *                  When provided, used instead of PTY. When omitted or
   *                  undefined, uses `script` for full TTY output capture.
   * @param options - Compiler service options
   */
  constructor(execFn?: ExecFunction, options: CompilerServiceOptions = {}) {
    this.execFn = execFn ?? null;
    this.options = {
      hierarchical: options.hierarchical ?? false,
      srcDir: options.srcDir ?? DEFAULT_SRC_DIR,
      outDir: options.outDir ?? DEFAULT_OUT_DIR,
    };
  }

  /**
   * Compiles a single .compact file using the Compact CLI.
   *
   * In production (no injected execFn): spawns under a PTY via `script`
   * to silently capture the full progress output including circuit constraint
   * lines. No terminal output is produced.
   *
   * In testing (injected execFn): calls the provided function directly.
   *
   * @param file    - Relative path to the .compact file from srcDir
   * @param flags   - Space-separated compiler flags
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
      if (this.execFn) {
        return await this.execFn('compact', args);
      }
      return await spawnWithPty(args);
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
