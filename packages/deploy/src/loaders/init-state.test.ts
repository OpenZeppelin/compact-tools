import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.ts';
import { loadInitialPrivateState } from './init-state.ts';

describe('loadInitialPrivateState', () => {
  it('returns undefined when ref is absent', async () => {
    expect(await loadInitialPrivateState(undefined, '/tmp')).toBeUndefined();
  });

  it('parses a { file } JSON ref with bigint revival', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'initstate-test-'));
    writeFileSync(join(dir, 's.json'), '{"counter":"100n","name":"x"}');
    const state = await loadInitialPrivateState({ file: 's.json' }, dir);
    expect(state).toEqual({ counter: 100n, name: 'x' });
  });

  it('throws ConfigError for missing files', async () => {
    await expect(
      loadInitialPrivateState({ file: 'does-not-exist.json' }, '/tmp'),
    ).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError for invalid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'initstate-test-'));
    writeFileSync(join(dir, 'bad.json'), 'not json');
    await expect(
      loadInitialPrivateState({ file: 'bad.json' }, dir),
    ).rejects.toThrow(ConfigError);
  });
});
