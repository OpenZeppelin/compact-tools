/**
 * Internal helpers for the Compact CLI tools.
 *
 * - **Glob matching** ({@link globToRegex}, {@link isExcluded}) — used by
 *   `FileDiscovery` to skip `.compact` files matching user-supplied patterns.
 * - **Shell quoting** ({@link shellQuote}, {@link buildFindExcludes}) — used by
 *   `CompactBuilder` to interpolate user-supplied values into bash commands
 *   safely.
 * - **Output cleaning** ({@link cleanCompileOutput}, {@link cleanForDisplay}) —
 *   strips ANSI codes, spinner artifacts, and control characters from
 *   `compact compile` output so it displays cleanly under turbo.
 */

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

// Precompiled patterns — built via `new RegExp` so biome's
// noControlCharactersInRegex rule doesn't fire on the literal escapes.
// biome-ignore lint/complexity/useRegexLiterals: control characters require RegExp constructor to avoid noControlCharactersInRegex
const CSI_RE = new RegExp(String.raw`\x1B\[[0-9;]*[A-Za-z]`, 'g');
// biome-ignore lint/complexity/useRegexLiterals: control characters require RegExp constructor to avoid noControlCharactersInRegex
const OSC_RE = new RegExp(String.raw`\x1B\][^\x07]*\x07`, 'g');
// biome-ignore lint/complexity/useRegexLiterals: control characters require RegExp constructor to avoid noControlCharactersInRegex
const CHARSET_RE = new RegExp(String.raw`\x1B[()][A-Z0-9]`, 'g');

/**
 * Strip ANSI escape sequences, spinner artifacts, and carriage returns from
 * `compact compile` output, leaving only clean visible text.
 *
 * The `compact compile` command uses ora-style spinners that write braille
 * characters and overwrite lines with `\r`. When `execFile` captures this to
 * a string, the control characters persist. When turbo buffers and replays
 * output from parallel tasks, the carriage returns cause lines to overwrite
 * each other, producing garbled/duplicated output.
 *
 * @param raw - Raw stdout/stderr from `compact compile`
 * @returns Cleaned output with only visible text
 */
export function cleanCompileOutput(raw: string): string {
  return (
    raw
      // CSI sequences (colors, cursor movement, erase)
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
 * line, ANSI codes, spinner artifacts, and empty lines.
 *
 * Drop-in replacement for `result.stdout.split('\n').slice(1).join('\n')`.
 *
 * @param raw - Raw stdout/stderr from `compact compile`
 * @returns Clean multi-line string suitable for terminal display
 */
export function cleanForDisplay(raw: string): string {
  return cleanCompileOutput(raw)
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('compactc ')) return false;
      return true;
    })
    .join('\n');
}
