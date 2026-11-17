import { glob, stat } from 'node:fs/promises';
import { posix, sep } from 'node:path';
import { ConfigError } from '../errors.ts';
import type { ContractEntry } from './schema.ts';

export type KeyKind = 'exact' | 'name' | 'directory';

/** Every `[contracts]` key that applies to a contract, and their merged entry. */
export interface ResolvedEntry {
  keys: string[];
  entry: ContractEntry;
}

/** `.compact` source paths under `dir`, relative and `/`-separated, by contract name. */
export interface SourceIndex {
  dir: string;
  byName: ReadonlyMap<string, readonly string[]>;
}

/** A key holding `/` is a directory pattern, one holding `*`, `?`, `[` or `{` a name pattern. */
export function keyKind(key: string): KeyKind {
  if (key.includes('/')) return 'directory';
  return /[*?[{]/.test(key) ? 'name' : 'exact';
}

/** Merges matching patterns in file order, then the exact key; a later key wins field by field. */
export function resolveEntry(
  name: string,
  contracts: Readonly<Record<string, ContractEntry>>,
  source: string | undefined,
): ResolvedEntry | undefined {
  const all = Object.keys(contracts);
  const patterns = all.filter((key) => {
    switch (keyKind(key)) {
      case 'name':
        return posix.matchesGlob(name, key);
      case 'directory':
        return (
          source !== undefined &&
          posix.matchesGlob(source, key.replace(/^(\.\/)+/, ''))
        );
      default:
        return false;
    }
  });
  const exact = all.filter((key) => key === name && keyKind(key) === 'exact');
  const keys = [...patterns, ...exact];
  if (keys.length === 0) return undefined;
  const merged: ContractEntry = Object.assign(
    { artifact: name },
    ...keys.map((key) => contracts[key]),
  );
  return { keys, entry: expandName(merged, name) as ContractEntry };
}

/** Indexes the `.compact` sources under `dir`, skipping `node_modules` and dot-directories. */
export async function indexSources(dir: string): Promise<SourceIndex> {
  const isDir = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) {
    throw new ConfigError(`[profile].src_dir is not a directory: ${dir}`);
  }
  const byName = new Map<string, string[]>();
  for await (const file of glob('**/*.compact', {
    cwd: dir,
    exclude: ['**/node_modules'],
  })) {
    const path = file.split(sep).join('/');
    const name = posix.basename(path, '.compact');
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  return { dir, byName };
}

/** The unique source of `name`, if any; several throw a {@link ConfigError}. */
export function sourceOf(name: string, index: SourceIndex): string | undefined {
  const paths = index.byName.get(name) ?? [];
  if (paths.length > 1) {
    throw new ConfigError(
      `Contract "${name}" matches ${paths.length} sources under ${index.dir}: ${[...paths].sort().join(', ')}`,
    );
  }
  return paths[0];
}

function expandName(value: unknown, name: string): unknown {
  if (typeof value === 'string') return value.replaceAll('{name}', name);
  if (Array.isArray(value)) return value.map((v) => expandName(v, name));
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, expandName(v, name)]),
    );
  }
  return value;
}
