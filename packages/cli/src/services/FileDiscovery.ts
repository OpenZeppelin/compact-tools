import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DEFAULT_SRC_DIR } from '../config.ts';

/**
 * Service responsible for discovering .compact files in the source directory.
 * Recursively scans directories and filters for .compact file extensions.
 *
 * @class FileDiscovery
 * @example
 * ```typescript
 * const discovery = new FileDiscovery('src');
 * const files = await discovery.getCompactFiles('src/security');
 * console.log(`Found ${files.length} .compact files`);
 * ```
 */
export class FileDiscovery {
  private srcDir: string;

  /**
   * Creates a new FileDiscovery instance.
   *
   * @param srcDir - Base source directory for relative path calculation (default: 'src')
   */
  constructor(srcDir: string = DEFAULT_SRC_DIR) {
    this.srcDir = srcDir;
  }

  /**
   * Recursively discovers all .compact files in a directory.
   * Returns relative paths from the srcDir for consistent processing.
   *
   * @param dir - Directory path to search (relative or absolute)
   * @returns Promise resolving to array of relative file paths
   * @example
   * ```typescript
   * const files = await discovery.getCompactFiles('src');
   * // Returns: ['contracts/Token.compact', 'security/AccessControl.compact']
   * ```
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
            return [relative(this.srcDir, fullPath)];
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
