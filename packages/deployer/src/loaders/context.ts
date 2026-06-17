import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError } from '../errors.ts';

/** Per-call I/O bundle for loaders. Centralises the `ConfigError`-wrapping boilerplate. */
export class LoaderContext {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  abs(p: string): string {
    return isAbsolute(p) ? p : resolve(this.rootDir, p);
  }

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
