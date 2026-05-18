import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type FileOrModuleRef,
  isFileRef,
  isModuleRef,
} from '../config/schema.ts';
import { ConfigError } from '../errors.ts';

/**
 * Load the initial private state passed to a contract's constructor.
 *
 * Source is either `{ file }` (JSON, with `"123n"` strings revived as
 * bigints) or `{ module, export }` (TS/JS module, value or zero-arg function).
 * Returns `undefined` when the config omits `init_private_state`.
 */
export async function loadInitialPrivateState(
  ref: FileOrModuleRef | undefined,
  rootDir: string,
): Promise<unknown> {
  if (!ref) return undefined;

  if (isFileRef(ref)) {
    const path = abs(rootDir, ref.file);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      throw new ConfigError(
        `init_private_state: failed to read ${path}: ${(e as Error).message}`,
      );
    }
    try {
      return JSON.parse(raw, bigintReviver);
    } catch (e) {
      throw new ConfigError(
        `init_private_state: invalid JSON at ${path}: ${(e as Error).message}`,
      );
    }
  }

  if (isModuleRef(ref)) {
    const path = abs(rootDir, ref.module);
    let mod: Record<string, unknown>;
    try {
      mod = await import(pathToFileURL(path).href);
    } catch (e) {
      throw new ConfigError(
        `init_private_state: failed to import ${path}: ${(e as Error).message}`,
      );
    }
    const exported = mod[ref.export];
    if (exported === undefined) {
      throw new ConfigError(
        `init_private_state: module ${path} has no export "${ref.export}"`,
      );
    }
    return typeof exported === 'function'
      ? await (exported as () => unknown)()
      : exported;
  }

  throw new ConfigError(
    'init_private_state must be { file } or { module, export }',
  );
}

function abs(rootDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(rootDir, p);
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && /^-?\d+n$/.test(value)) {
    return BigInt(value.slice(0, -1));
  }
  return value;
}
