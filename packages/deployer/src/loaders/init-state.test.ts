import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.ts';
import { InitialPrivateState } from './init-state.ts';

describe('InitialPrivateState', () => {
  it('should return undefined when ref is absent', async () => {
    expect(await InitialPrivateState.load(undefined, '/tmp')).toBeUndefined();
  });

  it('should parse a { file } JSON ref with bigint revival', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'initstate-test-'));
    writeFileSync(join(dir, 's.json'), '{"counter":"100n","name":"x"}');
    const state = await InitialPrivateState.load({ file: 's.json' }, dir);
    expect(state?.value).toEqual({ counter: 100n, name: 'x' });
  });

  it('should throw ConfigError for missing files', async () => {
    await expect(
      InitialPrivateState.load({ file: 'does-not-exist.json' }, '/tmp'),
    ).rejects.toThrow(ConfigError);
  });

  it('should throw ConfigError for invalid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'initstate-test-'));
    writeFileSync(join(dir, 'bad.json'), 'not json');
    await expect(
      InitialPrivateState.load({ file: 'bad.json' }, dir),
    ).rejects.toThrow(ConfigError);
  });

  it('should resolve a { module, export } ref to its exported value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'initstate-test-'));
    writeFileSync(
      join(dir, 'm.mjs'),
      'export const state = { counter: 5n, name: "from-mod" };',
    );
    const state = await InitialPrivateState.load(
      { module: 'm.mjs', export: 'state' },
      dir,
    );
    expect(state?.value).toEqual({ counter: 5n, name: 'from-mod' });
  });

  it('should throw ConfigError when the module export is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'initstate-test-'));
    writeFileSync(join(dir, 'm.mjs'), 'export const present = 1;');
    await expect(
      InitialPrivateState.load({ module: 'm.mjs', export: 'missing' }, dir),
    ).rejects.toThrow(/has no export "missing"/);
  });
});
