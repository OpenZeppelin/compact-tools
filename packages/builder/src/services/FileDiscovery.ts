import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DEFAULT_SRC_DIR } from '../types/options.ts';
import { isExcluded } from '../utils.ts';

/**
 * Service responsible for discovering .compact files in the source directory.
 * Recursively scans directories and filters for .compact file extensions,
 * applying user-supplied exclude patterns.
 *
 * @example
 * ```typescript
 * const discovery = new FileDiscovery('src', ['Mock*']);
 * const files = await discovery.getCompactFiles('src/security');
 * ```
 */
export class FileDiscovery {
  private srcDir: string;
  private excludes: readonly string[];

  /**
   * Creates a new FileDiscovery instance.
   *
   * @param srcDir   - Base source directory for relative path calculation (default: 'src')
   * @param excludes - Glob-style patterns of `.compact` files to skip.
   *                   Patterns containing `/` match against the full path
   *                   (as `find <srcDir>` would emit it); others match against
   *                   the filename only. Default: `[]`.
   */
  constructor(
    srcDir: string = DEFAULT_SRC_DIR,
    excludes: readonly string[] = [],
  ) {
    this.srcDir = srcDir;
    this.excludes = excludes;
  }

  /**
   * Recursively discovers all .compact files in a directory.
   * Returns relative paths from the srcDir for consistent processing.
   *
   * @param dir - Directory path to search (relative or absolute)
   * @returns Promise resolving to array of relative file paths
   */
  async getCompactFiles(dir: string): Promise<string[]> {
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      const filePromises = dirents.map(async (entry) => {
        const fullPath = join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            return await this.getCompactFiles(fullPath);
          }

          if (entry.isFile() && fullPath.endsWith('.compact')) {
            const relPath = relative(this.srcDir, fullPath);
            // Match path-style patterns against fullPath (i.e. the path that
            // `find srcDir` would emit) so users can write `*/archive/*` etc.,
            // identical to what they'd pass to `find -path`.
            if (isExcluded(entry.name, fullPath, this.excludes)) {
              return [];
            }
            return [relPath];
          }
          return [];
        } catch (err) {
          // biome-ignore lint/suspicious/noConsole: Needed to display error and file path
          console.warn(`Error accessing ${fullPath}:`, err);
          return [];
        }
      });

      const results = await Promise.all(filePromises);
      return results.flat();
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: Needed to display error and dir path
      console.error(`Failed to read dir: ${dir}`, err);
      return [];
    }
  }
}
