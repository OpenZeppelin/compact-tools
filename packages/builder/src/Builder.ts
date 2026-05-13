#!/usr/bin/env node

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { CompactCompiler } from './Compiler.ts';
import { isPromisifiedChildProcessError } from './types/errors.ts';
import {
  type BuilderOnlyOptions,
  type BuilderOptions,
  type BuildStep,
  DEFAULT_EXCLUDE_PATTERNS,
} from './types/options.ts';
import { buildFindExcludes, shellQuote } from './utils.ts';

// Re-export public types so consumers keep importing them from './Builder.js'.
export type { BuilderOnlyOptions, BuilderOptions };

// Promisified exec for async execution
const execAsync = promisify(exec);

/**
 * A class to handle the build process for a project.
 * Runs CompactCompiler as a prerequisite, then executes build steps (TypeScript compilation,
 * artifact copying, etc.) with progress feedback and colored output for success and error states.
 *
 * Build steps are derived from {@link BuilderOptions} so consumers can produce a
 * publishable distribution that matches their package conventions
 * (preserve source tree, copy metadata, clean dist, custom excludes).
 *
 * @notice `cmd` scripts discard `stderr` output and fail silently because this is
 * handled in `executeStep`.
 *
 * @example
 * ```typescript
 * // Default: flatten .compact files, exclude Mock*
 * const builder = new CompactBuilder({ flags: '--skip-zk' });
 *
 * // Library publish: clean dist, hierarchical tree, exclude mocks + archive, copy metadata.
 * const builder = new CompactBuilder({
 *   cleanDist: true,
 *   hierarchical: true,
 *   exclude: ['Mock*', '*\/archive\/*'],
 *   copyToDist: ['package.json', '../README.md'],
 * });
 * builder.build().catch(err => console.error(err));
 * ```
 */
export class CompactBuilder {
  private readonly options: BuilderOptions;
  private readonly steps: BuildStep[];

  /**
   * Constructs a new CompactBuilder instance.
   * @param options - Compiler + builder options (see {@link BuilderOptions}).
   */
  constructor(options: BuilderOptions = {}) {
    this.options = options;
    this.steps = this.buildSteps();
  }

  /**
   * Factory method to create a CompactBuilder from command-line arguments.
   *
   * @param args - Array of command-line arguments
   * @param env - Environment variables (defaults to process.env)
   * @returns New CompactBuilder instance configured from arguments
   */
  static fromArgs(
    args: string[],
    env: typeof process.env = process.env,
  ): CompactBuilder {
    const options = CompactBuilder.parseArgs(args, env);
    return new CompactBuilder(options);
  }

  /**
   * Parses command-line arguments into {@link BuilderOptions}.
   * Builder-only flags are extracted here; remaining args are forwarded to
   * {@link CompactCompiler.parseArgs} for compiler-side parsing.
   *
   * Builder-only flags (compiler flags like `--hierarchical` and `--exclude`
   * are forwarded to {@link CompactCompiler.parseArgs}):
   * - `--clean-dist`            - rm -rf dist before building
   * - `--copy <path>`           - copy an extra file into dist/ (repeatable)
   *
   * @throws {Error} If `--copy` is provided without a value.
   */
  static parseArgs(
    args: string[],
    env: typeof process.env = process.env,
  ): BuilderOptions {
    const builderOnly: BuilderOnlyOptions = {};
    const compilerArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--clean-dist') {
        builderOnly.cleanDist = true;
      } else if (arg === '--copy') {
        const value = args[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new Error('--copy flag requires a path');
        }
        builderOnly.copyToDist ??= [];
        builderOnly.copyToDist.push(value);
        i++;
      } else {
        compilerArgs.push(arg);
      }
    }

    const compilerOptions = CompactCompiler.parseArgs(compilerArgs, env);
    return { ...compilerOptions, ...builderOnly };
  }

  /**
   * Executes the full build process: compiles .compact files first, then runs build steps.
   * Displays progress with spinners and outputs results in color.
   *
   * @returns A promise that resolves when all steps complete successfully
   * @throws Error if compilation or any build step fails
   */
  public async build(): Promise<void> {
    // Run compact compilation as a prerequisite. CompactCompiler ignores
    // BuilderOnlyOptions because they aren't in its resolved shape.
    const compiler = new CompactCompiler(this.options);
    await compiler.compile();

    for (const [index, step] of this.steps.entries()) {
      await this.executeStep(step, index, this.steps.length);
    }
  }

  /**
   * Exposes the resolved build steps. Public for testing/introspection.
   */
  public getSteps(): readonly BuildStep[] {
    return this.steps;
  }

  /**
   * Assembles the build-step pipeline from the configured options.
   */
  private buildSteps(): BuildStep[] {
    const srcDir = this.options.srcDir ?? 'src';
    const quotedSrc = shellQuote(srcDir);
    const excludes = buildFindExcludes(
      this.options.exclude ?? DEFAULT_EXCLUDE_PATTERNS,
    );
    const steps: BuildStep[] = [];

    if (this.options.cleanDist) {
      steps.push({
        cmd: 'rm -rf dist && mkdir -p dist',
        msg: 'Cleaning dist directory',
        shell: '/bin/bash',
      });
    }

    steps.push({
      cmd: 'tsc --project tsconfig.build.json',
      msg: 'Compiling TypeScript',
    });

    steps.push({
      cmd: `mkdir -p dist/artifacts && cp -Rf ${quotedSrc}/artifacts/* dist/artifacts/ 2>/dev/null || true`,
      msg: 'Copying artifacts',
      shell: '/bin/bash',
    });

    if (this.options.hierarchical) {
      steps.push({
        // biome-ignore-start lint/suspicious/noUselessEscapeInString: shell vars must survive JS template-literal interpolation
        cmd: `
          SRC_DIR=${quotedSrc}
          find "$SRC_DIR" -type f -name '*.compact' ${excludes} | while read -r file; do
            rel_path="\${file#$SRC_DIR/}"
            mkdir -p "dist/$(dirname "$rel_path")"
            cp "$file" "dist/$rel_path"
          done
        `,
        // biome-ignore-end lint/suspicious/noUselessEscapeInString: shell vars must survive JS template-literal interpolation
        msg: 'Copying .compact files (preserving structure)',
        shell: '/bin/bash',
      });
    } else {
      steps.push({
        cmd: `mkdir -p dist && find ${quotedSrc} -type f -name '*.compact' ${excludes} -exec cp {} dist/ \\; 2>/dev/null || true`,
        msg: 'Copying .compact files',
        shell: '/bin/bash',
      });
    }

    const copyTargets = this.options.copyToDist ?? [];
    if (copyTargets.length > 0) {
      const copyCmds = copyTargets
        .map((path) => `cp ${shellQuote(path)} dist/ 2>/dev/null || true`)
        .join(' && ');
      steps.push({
        cmd: `mkdir -p dist && ${copyCmds}`,
        msg: 'Copying additional files to dist',
        shell: '/bin/bash',
      });
    }

    return steps;
  }

  /**
   * Executes a single build step.
   * Runs the command, shows a spinner, and prints output with indentation.
   *
   * @param step - The build step containing command and message
   * @param index - Current step index (0-based) for progress display
   * @param total - Total number of steps for progress display
   * @returns A promise that resolves when the step completes successfully
   * @throws Error if the step fails
   */
  private async executeStep(
    step: BuildStep,
    index: number,
    total: number,
  ): Promise<void> {
    const stepLabel: string = `[${index + 1}/${total}]`;
    const spinner: Ora = ora(`[BUILD] ${stepLabel} ${step.msg}`).start();

    try {
      const { stdout, stderr }: { stdout: string; stderr: string } =
        await execAsync(step.cmd, {
          shell: step.shell, // Only pass shell where needed
        });
      spinner.succeed(`[BUILD] ${stepLabel} ${step.msg}`);
      this.printOutput(stdout, chalk.cyan);
      this.printOutput(stderr, chalk.yellow); // Show stderr (warnings) in yellow if present
    } catch (error: unknown) {
      spinner.fail(`[BUILD] ${stepLabel} ${step.msg}`);
      if (isPromisifiedChildProcessError(error)) {
        this.printOutput(error.stdout, chalk.cyan);
        this.printOutput(error.stderr, chalk.red);
        // biome-ignore lint/suspicious/noConsole: Needed to display build failure reason
        console.error(chalk.red('[BUILD] ❌ Build failed:', error.message));
      } else if (error instanceof Error) {
        // biome-ignore lint/suspicious/noConsole: Needed to display build failure reason
        console.error(chalk.red('[BUILD] ❌ Build failed:', error.message));
      }

      // Library code must not call process.exit — let the caller (CLI wrapper
      // or programmatic consumer) decide how to react. We've already surfaced
      // the failure to the user via the spinner + printOutput above.
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('[BUILD] Build failed with a non-Error exception');
    }
  }

  /**
   * Prints command output with indentation and specified color.
   * Filters out empty lines and indents each line for readability.
   *
   * @param output - The command output string to print (stdout or stderr)
   * @param colorFn - Chalk color function to style the output (e.g., `chalk.cyan` for success, `chalk.red` for errors)
   */
  private printOutput(output: string, colorFn: (text: string) => string): void {
    const lines: string[] = output
      .split('\n')
      .filter((line: string): boolean => line.trim() !== '')
      .map((line: string): string => `    ${line}`);
    console.log(colorFn(lines.join('\n')));
  }
}
