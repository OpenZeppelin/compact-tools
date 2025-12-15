import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, normalize, relative, resolve } from 'node:path';
import { DEFAULT_SRC_DIR } from '../config.ts';
import { CompilationError } from '../types/errors.ts';

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
   * Validates and normalizes a file path to prevent command injection.
   * Ensures the path exists, resolves symlinks, and is within allowed directories.
   *
   * @param filePath - The file path to validate
   * @param allowedBaseDir - Base directory that the path must be within
   * @returns Normalized absolute path
   * @throws {CompilationError} If path is invalid or contains unsafe characters
   * @example
   * ```typescript
   * const discovery = new FileDiscovery('src');
   * const safePath = discovery.validateAndNormalizePath(
   *   'src/MyToken.compact',
   *   'src'
   * );
   * ```
   */
  validateAndNormalizePath(filePath: string, allowedBaseDir: string): string {
    // Normalize the path to resolve '..' and '.' segments
    const normalized = normalize(filePath);

    // Check for shell metacharacters and embedded quotes
    if (/[;&|`$(){}[\]<>'"\\]/.test(normalized)) {
      throw new CompilationError(
        `Invalid file path: contains unsafe characters: ${filePath}`,
        filePath,
      );
    }

    // Resolve to absolute path
    const absolutePath = resolve(normalized);

    // Ensure path exists
    if (!existsSync(absolutePath)) {
      throw new CompilationError(
        `File path does not exist: ${filePath}`,
        filePath,
      );
    }

    // Resolve symlinks to get real path
    let realPath: string;
    try {
      realPath = realpathSync(absolutePath);
    } catch {
      throw new CompilationError(
        `Failed to resolve file path: ${filePath}`,
        filePath,
      );
    }

    // Ensure path is within allowed base directory
    const allowedBase = resolve(allowedBaseDir);
    const relativePath = relative(allowedBase, realPath);

    // Check if path is outside allowed directory
    // relative() returns paths starting with '..' if outside, or absolute paths on some systems
    if (
      relativePath.startsWith('..') ||
      relativePath.startsWith('/') ||
      (relativePath.length > 1 && relativePath[1] === ':') // Windows absolute path (C:)
    ) {
      throw new CompilationError(
        `File path is outside allowed directory: ${filePath}`,
        filePath,
      );
    }

    return realPath;
  }

  /**
   * Recursively discovers all .compact files in a directory.
   * Returns relative paths from the srcDir for consistent processing.
   * Validates paths during discovery to prevent command injection.
   *
   * @param dir - Directory path to search (relative or absolute)
   * @returns Promise resolving to array of relative file paths
   * @throws {CompilationError} If a discovered file path contains unsafe characters
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
            // Validate path during discovery to prevent command injection
            this.validateAndNormalizePath(fullPath, this.srcDir);
            return [relative(this.srcDir, fullPath)];
          }
          return [];
        } catch (err) {
          // If validation fails, throw the error (don't silently skip)
          if (err instanceof CompilationError) {
            throw err;
          }
          // biome-ignore lint/suspicious/noConsole: Needed to display error and file path
          console.warn(`Error accessing ${fullPath}:`, err);
          return [];
        }
      });

      const results = await Promise.all(filePromises);
      return results.flat();
    } catch (err) {
      // If it's a validation error, re-throw it
      if (err instanceof CompilationError) {
        throw err;
      }
      // biome-ignore lint/suspicious/noConsole: Needed to display error and dir path
      console.error(`Failed to read dir: ${dir}`, err);
      return [];
    }
  }
}
