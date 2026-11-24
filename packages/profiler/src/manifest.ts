import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Measurement } from './transaction.ts';

/** `serial` when two copies of the transaction cannot share a block. */
export type Conflict = 'none' | 'serial';

/** One manifest entry, in the crate's schema version 1. */
export interface ManifestScenario {
  name: string;
  series?: string;
  n?: number;
  calls: number;
  ops: number;
  conflict: Conflict;
  /** Relative to the manifest. */
  tx: string;
  js: Measurement;
}

export interface Manifest {
  schemaVersion: 1;
  contract: string;
  toolchain: Record<string, string>;
  paramsIdentity: string;
  scenarios: ManifestScenario[];
}

/** File-name form of a scenario name: lower case, runs of other characters as one `-`. */
export function slugify(name: string): string {
  let slug = name.toLowerCase().replace(/[^a-z0-9_]+/g, '-');
  // The replace leaves at most one dash at each end.
  if (slug.startsWith('-')) slug = slug.slice(1);
  if (slug.endsWith('-')) slug = slug.slice(0, -1);
  if (slug === '') {
    throw new Error(`scenario name ${JSON.stringify(name)} has no file name`);
  }
  return slug;
}

/**
 * Version of the copy of `pkg` this module imports, read from the `package.json` above its
 * entry point; `exports` maps may not expose `package.json` itself.
 */
export function resolvedVersion(pkg: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(pkg)));
  for (;;) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(dir, 'package.json'), 'utf8'),
      ) as { name?: string; version?: string };
      if (manifest.name === pkg && manifest.version !== undefined) {
        return manifest.version;
      }
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`cannot find the package.json of ${pkg}`);
    }
    dir = parent;
  }
}

/** Semver precedence, prerelease included: `1.0.0-rc.5` sorts below `1.0.0`. */
export function compareVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match =
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        version,
      );
    if (match === null) {
      throw new Error(`${version} is not a semver version`);
    }
    return {
      core: [match[1], match[2], match[3]].map(Number),
      pre: match[4]?.split('.') ?? [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    const diff = a.core[index]! - b.core[index]!;
    if (diff !== 0) return Math.sign(diff);
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return Math.sign(b.pre.length - a.pre.length);
  }
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numeric = /^\d+$/;
    if (numeric.test(x) && numeric.test(y)) {
      return Math.sign(Number(x) - Number(y));
    }
    if (numeric.test(x)) return -1;
    if (numeric.test(y)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
