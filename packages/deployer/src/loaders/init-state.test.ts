import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.ts';
import { InitialPrivateState } from './init-state.ts';

describe('InitialPrivateState', () => {
  it('returns undefined when ref is absent', async () => {
    expect(await InitialPrivateState.load(undefined, '/tmp')).toBeUndefined();
  });

  it('parses a { file } JSON ref with bigint revival', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'initstate-test-'));
    writeFileSync(join(dir, 's.json'), '{"counter":"100n","name":"x"}');
    const state = await InitialPrivateState.load({ file: 's.json' }, dir);
    expect(state?.value).toEqual({ counter: 100n, name: 'x' });
  });

  it('throws ConfigError for missing files', async () => {
    await expect(
      InitialPrivateState.load({ file: 'does-not-exist.json' }, '/tmp'),
    ).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError for invalid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'initstate-test-'));
    writeFileSync(join(dir, 'bad.json'), 'not json');
    await expect(
      InitialPrivateState.load({ file: 'bad.json' }, dir),
    ).rejects.toThrow(ConfigError);
  });
});
