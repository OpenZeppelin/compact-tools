import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompilerService } from '../src/Compiler.js';

describe('CompilerService under a PTY', () => {
  let binDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'fake-compact-'));
    // Stands in for `compact`: prints the size of the terminal it runs in.
    writeFileSync(join(binDir, 'compact'), '#!/bin/sh\nstty size\n');
    chmodSync(join(binDir, 'compact'), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${savedPath}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  it('gives the compiler a 500-row, 200-column terminal', async () => {
    const { stdout } = await new CompilerService().compileFile(
      'Any.compact',
      '',
    );

    expect(stdout).toMatch(/^500 200\r?$/m);
  });
});
