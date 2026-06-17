import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.ts';
import { LoaderContext } from './context.ts';
import { RefResolver } from './ref-resolver.ts';

const parseJsonNumber = (text: string): number => Number.parseInt(text, 10);
const expectNumber = (value: unknown): number => {
  if (typeof value !== 'number') throw new ConfigError('not a number');
  return value;
};

describe('RefResolver.resolve — file branch', () => {
  it('should read the file and run parseFile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refres-file-'));
    writeFileSync(join(dir, 'n.txt'), '42');
    const r = new RefResolver<number>(new LoaderContext(dir), 'args');

    const out = await r.resolve(
      { file: 'n.txt' },
      parseJsonNumber,
      expectNumber,
    );
    expect(out).toBe(42);
  });

  it('should propagate ConfigError from a missing file', async () => {
    const r = new RefResolver<number>(new LoaderContext('/tmp'), 'args');
    await expect(
      r.resolve(
        { file: 'does-not-exist-xx.txt' },
        parseJsonNumber,
        expectNumber,
      ),
    ).rejects.toThrow(ConfigError);
  });
});

describe('RefResolver.resolve — module branch', () => {
  it('should import a module and pick the named export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refres-mod-'));
    writeFileSync(
      join(dir, 'm.mjs'),
      'export const seven = 7; export default 99;',
    );
    const r = new RefResolver<number>(new LoaderContext(dir), 'args');

    const out = await r.resolve(
      { module: 'm.mjs', export: 'seven' },
      parseJsonNumber,
      expectNumber,
    );
    expect(out).toBe(7);
  });

  it('should call a function-shaped export and use its return value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refres-fn-'));
    writeFileSync(
      join(dir, 'm.mjs'),
      'export const factory = async () => 123;',
    );
    const r = new RefResolver<number>(new LoaderContext(dir), 'args');

    const out = await r.resolve(
      { module: 'm.mjs', export: 'factory' },
      parseJsonNumber,
      expectNumber,
    );
    expect(out).toBe(123);
  });

  it('should let validateExport throw to reject bad export shapes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refres-bad-'));
    writeFileSync(join(dir, 'm.mjs'), 'export const value = "not a number";');
    const r = new RefResolver<number>(new LoaderContext(dir), 'args');

    await expect(
      r.resolve(
        { module: 'm.mjs', export: 'value' },
        parseJsonNumber,
        expectNumber,
      ),
    ).rejects.toThrow(ConfigError);
  });

  it('should propagate ConfigError when the module path is unimportable', async () => {
    const r = new RefResolver<number>(new LoaderContext('/tmp'), 'args');
    await expect(
      r.resolve(
        { module: 'nope-zz.mjs', export: 'default' },
        parseJsonNumber,
        expectNumber,
      ),
    ).rejects.toThrow(ConfigError);
  });
});

describe('RefResolver.resolve — invalid ref', () => {
  it('should throw a ConfigError carrying the label for unknown ref shapes', async () => {
    const r = new RefResolver<number>(new LoaderContext('/tmp'), 'my-label');
    await expect(
      r.resolve(
        { unknown: 'thing' } as unknown as Parameters<typeof r.resolve>[0],
        parseJsonNumber,
        expectNumber,
      ),
    ).rejects.toThrow(/my-label/);
  });
});
