import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(here, '..', '..', 'src');
const LIVE_DIR = join(SRC_DIR, 'live');

/** All `.ts` files under a directory, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const MIDNIGHT_JS = '@midnight-ntwrk/midnight-js';

/**
 * Dependency-wall enforcement (the CI guard from OQ6).
 *
 * The dry dependency graph must pull zero midnight-js. We enforce the structural
 * precondition: every midnight-js import is physically confined to `src/live/`.
 * Any reference elsewhere — even a `type` import — is flagged, since a stray
 * value re-export is exactly how the wall silently falls.
 *
 * A stronger bundle/dependency-graph analysis (the other OQ6 option) can layer
 * on top; this source-level guard is the fast, deterministic floor.
 */
describe('dependency wall', () => {
  it('confines every midnight-js import to src/live/', () => {
    const offenders = tsFiles(SRC_DIR)
      .filter((file) => !file.startsWith(LIVE_DIR))
      .filter((file) => readFileSync(file, 'utf8').includes(MIDNIGHT_JS))
      .map((file) => relative(SRC_DIR, file));

    expect(offenders).toEqual([]);
  });

  it('keeps midnight-js out of the main barrel', () => {
    const barrel = readFileSync(join(SRC_DIR, 'index.ts'), 'utf8');
    expect(barrel.includes(MIDNIGHT_JS)).toBe(false);
    // The live adapter must be a type-only re-export, never a value re-export.
    expect(barrel).toContain('export type { LiveBackend }');
    expect(barrel).not.toMatch(/export\s*\{\s*LiveBackend\b/);
  });
});
