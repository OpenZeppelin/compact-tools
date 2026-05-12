/**
 * Internal helpers for the Compact CLI tools.
 *
 * - **Glob matching** ({@link globToRegex}, {@link isExcluded}) — used by
 *   `FileDiscovery` to skip `.compact` files matching user-supplied patterns.
 * - **Shell quoting** ({@link shellQuote}, {@link buildFindExcludes}) — used by
 *   `CompactBuilder` to interpolate user-supplied values into bash commands
 *   safely.
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
