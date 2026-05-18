import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError } from '../errors.ts';

/**
 * Per-call helper bundle for loaders.
 *
 * Wraps `rootDir` and the three I/O primitives every loader needs — path
 * resolution, UTF-8 file read, ES-module import — so the `try { … } catch
 * (e) { throw new ConfigError(…) }` boilerplate lives in exactly one place.
 */
export class LoaderContext {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /** Resolve `p` against `rootDir`, unless `p` is already absolute. */
  abs(p: string): string {
    return isAbsolute(p) ? p : resolve(this.rootDir, p);
  }

  /** Read a UTF-8 file; returns the text alongside the absolute path used. */
  async readText(
    p: string,
    label: string,
  ): Promise<{ text: string; path: string }> {
    const path = this.abs(p);
    try {
      const text = await readFile(path, 'utf8');
      return { text, path };
    } catch (e) {
      throw new ConfigError(
        `${label}: failed to read ${path}: ${(e as Error).message}`,
      );
    }
  }

  /** Dynamic-import an ES module by file path; returns module + absolute path. */
  async importModule(
    p: string,
    label: string,
  ): Promise<{ mod: Record<string, unknown>; path: string }> {
    const path = this.abs(p);
    try {
      const mod = (await import(pathToFileURL(path).href)) as Record<
        string,
        unknown
      >;
      return { mod, path };
    } catch (e) {
      throw new ConfigError(
        `${label}: failed to import ${path}: ${(e as Error).message}`,
      );
    }
  }
}
