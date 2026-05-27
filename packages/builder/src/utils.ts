/**
 * Internal helpers for the Compact CLI tools.
 *
 * - **Glob matching** ({@link globToRegex}, {@link isExcluded}) — used by
 *   `FileDiscovery` to skip `.compact` files matching user-supplied patterns.
 * - **Shell quoting** ({@link shellQuote}, {@link buildFindExcludes}) — used by
 *   `CompactBuilder` to interpolate user-supplied values into bash commands
 *   safely.
 * - **Output cleaning** ({@link cleanCompileOutput}, {@link cleanForDisplay},
 *   {@link parseCircuitConstraints}) — strips ANSI codes, spinner artifacts,
 *   and cursor-movement sequences from `compact compile` PTY output and
 *   extracts circuit constraint data.
 * - **Circuit info persistence** ({@link writeCircuitInfoJson}) — writes
 *   `.circuit-info.json` files with parsed circuit constraints.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
 */
export function isExcluded(
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

// ─── Circuit info file ──────────────────────────────────────────────────

/**
 * Shape of the `.circuit-info.json` file written per source directory.
 */
export interface CircuitInfoFile {
  /** ISO timestamp of when this file was last generated */
  generatedAt: string;
  /** Map of compiled filename → circuit constraints */
  files: Record<string, CircuitConstraint[]>;
}

/**
 * Write or merge circuit constraint data into a `.circuit-info.json` file
 * in the source directory of the compiled file.
 *
 * If the file already exists, the entry for the given file is updated and
 * other entries are preserved. The `generatedAt` timestamp is always updated.
 *
 * @param file     - Relative path to the compiled .compact file (from srcDir)
 * @param srcDir   - Base source directory
 * @param circuits - Parsed circuit constraints to write
 * @returns The absolute path to the written `.circuit-info.json` file
 */
export function writeCircuitInfoJson(
  file: string,
  srcDir: string,
  circuits: CircuitConstraint[],
): string {
  const srcFilePath = resolve(srcDir, file);
  const dir = dirname(srcFilePath);
  const jsonPath = resolve(dir, '.circuit-info.json');

  let existing: CircuitInfoFile = { generatedAt: '', files: {} };
  try {
    existing = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  } catch {
    // File doesn't exist or is invalid, start fresh
  }

  const fileName = file.split('/').pop() ?? file;
  existing.generatedAt = new Date().toISOString();
  existing.files[fileName] = circuits;

  mkdirSync(dir, { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');
  return jsonPath;
}
