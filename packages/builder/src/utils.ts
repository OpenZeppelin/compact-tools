/**
 * Internal helpers for the Compact CLI tools.
 *
 * - **Glob matching** ({@link globToRegex}, {@link matchesAnyPattern}) — used
 *   by `FileDiscovery` to apply the user-supplied include/exclude patterns to
 *   `.compact` files.
 * - **Shell quoting** ({@link shellQuote}, {@link buildFindExcludes},
 *   {@link buildFindIncludes}) — used by `CompactBuilder` to interpolate
 *   user-supplied values into bash commands safely.
 * - **Output cleaning** ({@link cleanCompileOutput}, {@link cleanForDisplay},
 *   {@link parseCircuitConstraints}) — strips ANSI codes, spinner artifacts,
 *   and cursor-movement sequences from `compact compile` PTY output and
 *   extracts circuit constraint data.
 * - **Artifact layout** ({@link artifactDir}) — resolves the per-contract
 *   output directory `compact compile` writes into.
 * - **Circuit info persistence** ({@link writeCircuitInfo}) — writes
 *   `circuit-info.json` into a contract's artifact directory.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
/**
 * Converts a simple glob pattern to a regular expression.
 * Supports `*` (any sequence) and `?` (single char). All other glob features
 * (brace expansion, character classes) are not supported — keep patterns simple.
 */
export function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[\\^$+|.()[\]{}]/g, '\\$&');
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`);
}

/**
 * Returns true if `filename`/`fullPath` matches any of the given glob patterns.
 *
 * - Patterns containing `/` are matched against `fullPath` (the path as
 *   `find srcDir` would emit it, e.g. `'src/archive/Foo.compact'`).
 * - Patterns without `/` are matched against `filename` only.
 *
 * This mirrors the semantic of `find -name <pattern>` vs `find -path <pattern>`.
 * Both the exclude list and the include (`only`) list are resolved through it,
 * so the two flags accept identical patterns.
 */
export function matchesAnyPattern(
  filename: string,
  fullPath: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => {
    const target = pattern.includes('/') ? fullPath : filename;
    return globToRegex(pattern).test(target);
  });
}

/**
 * Shell-quotes a string for safe interpolation into a single-quoted bash arg.
 *
 * @example
 * shellQuote("foo")       // "'foo'"
 * shellQuote("it's")      // "'it'\\''s'"
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds the `find`-compatible exclusion fragment for the given patterns.
 * Patterns containing `/` are emitted as `! -path '<pattern>'`; others as
 * `! -name '<pattern>'`. Single-quoting ensures safe shell interpolation.
 *
 * @example
 * buildFindExcludes(['Mock*', '*\/archive\/*'])
 * // "! -name 'Mock*' ! -path '*\/archive\/*'"
 */
export function buildFindExcludes(patterns: readonly string[]): string {
  return patterns
    .map((pattern) =>
      pattern.includes('/')
        ? `! -path ${shellQuote(pattern)}`
        : `! -name ${shellQuote(pattern)}`,
    )
    .join(' ');
}

/**
 * Builds the `find`-compatible inclusion fragment for the given patterns.
 * The tests are OR-ed inside a `\( … \)` group so `find`'s implicit AND with
 * the surrounding tests keeps its meaning. Returns `''` for an empty list,
 * which leaves the `find` invocation unfiltered.
 *
 * @example
 * buildFindIncludes(['MockEcdsa.compact', '*\/legacy\/*'])
 * // "\\( -name 'MockEcdsa.compact' -o -path '*\/legacy\/*' \\)"
 */
export function buildFindIncludes(patterns: readonly string[]): string {
  if (patterns.length === 0) return '';
  const tests = patterns
    .map((pattern) =>
      pattern.includes('/')
        ? `-path ${shellQuote(pattern)}`
        : `-name ${shellQuote(pattern)}`,
    )
    .join(' -o ');
  return `\\( ${tests} \\)`;
}

// ─── Compile output cleaning ────────────────────────────────────────────

// Precompiled patterns — built via `new RegExp` so biome's
// noControlCharactersInRegex rule doesn't fire on the literal escapes.
// biome-ignore lint/complexity/useRegexLiterals: control characters require RegExp constructor to avoid noControlCharactersInRegex
const CSI_RE = new RegExp(String.raw`\x1B\[[0-9;]*[A-Za-z]`, 'g');
// biome-ignore lint/complexity/useRegexLiterals: control characters require RegExp constructor to avoid noControlCharactersInRegex
const OSC_RE = new RegExp(String.raw`\x1B\][^\x07]*\x07`, 'g');
// biome-ignore lint/complexity/useRegexLiterals: control characters require RegExp constructor to avoid noControlCharactersInRegex
const CHARSET_RE = new RegExp(String.raw`\x1B[()][A-Z0-9]`, 'g');

/**
 * Strip ANSI escape sequences, spinner artifacts, cursor-movement sequences,
 * and carriage returns from `compact compile` output.
 *
 * `compactc` writes its progress UI (per-circuit spinner lines with constraint
 * info) directly to the TTY using cursor-up/erase-line sequences to redraw
 * the display on every spinner frame. When captured via a PTY (e.g. `node-pty`
 * or `script`), the raw output contains hundreds of redraw frames. This
 * function strips all the control sequences, then the `\r`-based line
 * overwrites, leaving clean text that can be parsed or displayed.
 *
 * @param raw - Raw output from `compact compile` (captured via PTY)
 * @returns Cleaned output with only visible text
 */
export function cleanCompileOutput(raw: string): string {
  return (
    raw
      // CSI sequences (colors, cursor movement, erase line, etc.)
      .replace(CSI_RE, '')
      // OSC sequences (terminal title, etc.)
      .replace(OSC_RE, '')
      // Character set designation
      .replace(CHARSET_RE, '')
      // Carriage returns (spinner overwrites) — keep only the last frame
      .replace(/^.*\r(?!\n)/gm, '')
      // Unicode spinner/check characters (braille patterns + common symbols)
      .replace(/[\u2800-\u28FF⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓✔✗✘⣾⣽⣻⢿⡿⣟⣯⣷]/g, '')
      // Collapse whitespace runs (preserve newlines)
      .replace(/[^\S\n]+/g, ' ')
      // Trim each line
      .replace(/^ | $/gm, '')
  );
}

/**
 * Clean `compact compile` output for display: strips the `compactc` version
 * line, ANSI codes, spinner artifacts, cursor redraws, and duplicate/empty
 * lines.
 *
 * Since `compactc` redraws all circuit lines on every spinner frame, the
 * cleaned output will contain many duplicates. This function deduplicates
 * by keeping the last occurrence of each `circuit "name" (...)` line and
 * the final progress bar state.
 *
 * @param raw - Raw output from `compact compile` (captured via PTY or pipe)
 * @returns Clean multi-line string suitable for terminal display
 */
export function cleanForDisplay(raw: string): string {
  const cleaned = cleanCompileOutput(raw);
  const lines = cleaned.split('\n');

  // Deduplicate: for circuit lines, keep last occurrence; for others, keep unique
  const circuitLines = new Map<string, string>();
  const otherLines: string[] = [];
  let compilingLine = '';
  let progressLine = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('compactc ')) continue;

    const circuitMatch = trimmed.match(
      /circuit\s+"([^"]+)"\s*\(k\s*=\s*\d+\s*,\s*rows\s*=\s*\d+\s*\)/,
    );
    if (circuitMatch) {
      circuitLines.set(circuitMatch[1], trimmed);
    } else if (trimmed.startsWith('Compiling ')) {
      compilingLine = trimmed;
    } else if (trimmed.startsWith('Overall progress')) {
      progressLine = trimmed;
    } else if (
      // Skip partial circuit lines (no k/rows yet, just spinner)
      !trimmed.match(/^circuit\s+"[^"]+"/)
    ) {
      otherLines.push(trimmed);
    }
  }

  const result: string[] = [];
  if (compilingLine) result.push(compilingLine);
  for (const line of circuitLines.values()) {
    result.push(`  ${line}`);
  }
  if (progressLine) result.push(progressLine);
  result.push(...otherLines);

  return result.join('\n');
}

/**
 * Parsed circuit constraint from compile output.
 */
export interface CircuitConstraint {
  name: string;
  k: number;
  rows: number;
}

/**
 * Parse circuit constraint info from `compact compile` output.
 *
 * Extracts all `circuit "name" (k=N, rows=N)` occurrences, deduplicates
 * by circuit name (last occurrence wins — which is the final spinner state
 * with complete k + rows values).
 *
 * @param rawOutput - Raw output from `compact compile` (PTY or pipe)
 * @returns Array of unique circuit constraints
 */
export function parseCircuitConstraints(
  rawOutput: string,
): CircuitConstraint[] {
  const cleaned = cleanCompileOutput(rawOutput);
  const circuitPattern =
    /circuit\s+"([^"]+)"\s*\(k\s*=\s*(\d+)\s*,\s*rows\s*=\s*(\d+)\s*\)/g;

  // Deduplicate by name — last match wins (final spinner state)
  const circuits = new Map<string, CircuitConstraint>();
  for (const match of cleaned.matchAll(circuitPattern)) {
    circuits.set(match[1], {
      name: match[1],
      k: Number.parseInt(match[2], 10),
      rows: Number.parseInt(match[3], 10),
    });
  }

  return [...circuits.values()];
}

// ─── Artifact layout ────────────────────────────────────────────────────

/**
 * Resolve the artifact directory `compact compile` writes a contract into.
 *
 * Flattened (default): `<outDir>/<Contract>/`. Hierarchical:
 * `<outDir>/<subdir>/<Contract>/`, except for sources at the root of `srcDir`,
 * which have no subdir and stay flattened.
 *
 * @param outDir       - Base artifacts directory
 * @param file         - Relative path to the .compact file (from srcDir)
 * @param hierarchical - Whether to mirror the source directory structure
 * @returns The contract's artifact directory, under `outDir`
 */
export function artifactDir(
  outDir: string,
  file: string,
  hierarchical: boolean,
): string {
  const fileDir = dirname(file);
  const contract = basename(file, '.compact');
  return hierarchical && fileDir !== '.'
    ? join(outDir, fileDir, contract)
    : join(outDir, contract);
}

// ─── Circuit info file ──────────────────────────────────────────────────

/**
 * Shape of the `circuit-info.json` file written per compiled contract.
 */
export interface CircuitInfo {
  /** ISO timestamp of when this file was generated */
  generatedAt: string;
  /** Path of the compiled .compact file relative to srcDir, forward slashes */
  source: string;
  /** Circuit constraints in the compiler's output order */
  circuits: CircuitConstraint[];
}

/**
 * Write circuit constraint data to `circuit-info.json` in a contract's
 * artifact directory, beside the compiler's own output.
 *
 * Each compile replaces the file; nothing is merged from a previous run.
 *
 * @param outputDir - The contract's artifact directory, created if missing
 * @param file      - Relative path to the compiled .compact file (from srcDir)
 * @param circuits  - Parsed circuit constraints to write
 * @returns The absolute path to the written `circuit-info.json` file
 */
export function writeCircuitInfo(
  outputDir: string,
  file: string,
  circuits: CircuitConstraint[],
): string {
  const jsonPath = resolve(outputDir, 'circuit-info.json');
  const info: CircuitInfo = {
    generatedAt: new Date().toISOString(),
    source: file.replaceAll('\\', '/'),
    circuits,
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(info, null, 2)}\n`, 'utf-8');
  return jsonPath;
}
