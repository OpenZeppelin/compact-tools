import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.ts';
import { LoaderContext } from './context.ts';

describe('LoaderContext.abs', () => {
  it('should leave absolute paths unchanged', () => {
    const ctx = new LoaderContext('/some/root');
    expect(ctx.abs('/abs/path/file.json')).toBe('/abs/path/file.json');
  });

  it('should resolve relative paths against rootDir', () => {
    const ctx = new LoaderContext('/some/root');
    const resolved = ctx.abs('inner/file.json');
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe('/some/root/inner/file.json');
  });
});

describe('LoaderContext.readText', () => {
  it('should read a file and return text + absolute path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loader-ctx-'));
    writeFileSync(join(dir, 'hello.txt'), 'world');
    const ctx = new LoaderContext(dir);

    const { text, path } = await ctx.readText('hello.txt', 'label');
    expect(text).toBe('world');
    expect(path).toBe(join(dir, 'hello.txt'));
  });

  it('should wrap ENOENT in ConfigError with the label and path', async () => {
    const ctx = new LoaderContext('/tmp');
    await expect(
      ctx.readText('does-not-exist-zzz.txt', 'my-label'),
    ).rejects.toThrow(ConfigError);
    await expect(
      ctx.readText('does-not-exist-zzz.txt', 'my-label'),
    ).rejects.toThrow(/my-label.*failed to read/);
  });
});

describe('LoaderContext.importModule', () => {
  it('should dynamic-import a module from a relative path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loader-ctx-imp-'));
    writeFileSync(
      join(dir, 'sample.mjs'),
      'export const value = 42; export default { value: 7 };',
    );
    const ctx = new LoaderContext(dir);

    const { mod, path } = await ctx.importModule('sample.mjs', 'label');
    expect(mod.value).toBe(42);
    expect(path).toBe(join(dir, 'sample.mjs'));
  });

  it('should wrap import failures in ConfigError', async () => {
    const ctx = new LoaderContext('/tmp');
    await expect(
      ctx.importModule('nope-not-there.mjs', 'mods'),
    ).rejects.toThrow(ConfigError);
    await expect(
      ctx.importModule('nope-not-there.mjs', 'mods'),
    ).rejects.toThrow(/mods.*failed to import/);
  });

  it('should accept absolute paths unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loader-ctx-abs-'));
    const abs = join(dir, 'abs.mjs');
    writeFileSync(abs, 'export const ok = true;');
    const ctx = new LoaderContext('/unused/root');

    const { mod, path } = await ctx.importModule(abs, 'l');
    expect(mod.ok).toBe(true);
    expect(path).toBe(abs);
  });
});
