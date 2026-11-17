import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

function read(...segments: string[]): string {
  return readFileSync(join(packageDir, ...segments), 'utf8');
}

describe('the published version', () => {
  it('matches the crate the package downloads', () => {
    const published = (JSON.parse(read('package.json')) as { version: string })
      .version;
    const crate = /^version = "(.+)"$/m.exec(
      read('..', '..', 'crates', 'compact-lint', 'Cargo.toml'),
    );

    expect(crate?.[1]).toBe(published);
  });
});
