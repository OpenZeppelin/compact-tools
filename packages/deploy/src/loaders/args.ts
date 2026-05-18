import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type ContractConfig,
  isFileRef,
  isModuleRef,
} from '../config/schema.ts';
import { ConfigError } from '../errors.ts';

/**
 * Resolve a contract's constructor args from CLI / TOML / file / module.
 *
 * Precedence (highest first):
 *  1. `override` (CLI `--args '[…]'`, parsed as JSON).
 *  2. Inline `args = [...]` array in TOML.
 *  3. `args = { file = "…" }` → JSON file (bigints encoded as `"123n"`).
 *  4. `args = { module = "…", export = "…" }` → ES module export (value
 *     or zero-arg function returning an array).
 *
 * Returns `[]` when no source supplies args.
 */
export async function loadConstructorArgs(
  contract: ContractConfig,
  rootDir: string,
  override?: string,
): Promise<unknown[]> {
  if (override !== undefined) {
    return parseJsonArray(override, '--args');
  }
  const raw = contract.args;
  if (raw === undefined) return [];

  if (Array.isArray(raw)) return raw;

  if (isFileRef(raw)) {
    const path = abs(rootDir, raw.file);
    const text = await safeRead(path, 'args file');
    return parseJsonArray(text, path);
  }

  if (isModuleRef(raw)) {
    const path = abs(rootDir, raw.module);
    let mod: Record<string, unknown>;
    try {
      mod = await import(pathToFileURL(path).href);
    } catch (e) {
      throw new ConfigError(
        `args: failed to import ${path}: ${(e as Error).message}`,
      );
    }
    const exported = mod[raw.export];
    const resolved =
      typeof exported === 'function'
        ? await (exported as () => unknown)()
        : exported;
    if (!Array.isArray(resolved)) {
      throw new ConfigError(
        `args: module ${path} export "${raw.export}" must be an array`,
      );
    }
    return resolved;
  }

  throw new ConfigError(
    'args must be an inline array, { file }, or { module, export }',
  );
}

function abs(rootDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(rootDir, p);
}

function parseJsonArray(text: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (_k, v) =>
      typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    );
  } catch (e) {
    throw new ConfigError(
      `args: invalid JSON at ${label}: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError(`args at ${label} must be a JSON array`);
  }
  return parsed;
}

async function safeRead(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    throw new ConfigError(
      `Failed to read ${label} (${path}): ${(e as Error).message}`,
    );
  }
}
