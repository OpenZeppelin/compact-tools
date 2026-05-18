import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContractConfig } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import { loadConstructorArgs } from './args.ts';

const baseContract = (extra: Partial<ContractConfig> = {}): ContractConfig =>
  ({
    artifact: 'x',
    signing_key_file: 'x.sk',
    ...extra,
  }) as ContractConfig;

describe('loadConstructorArgs', () => {
  it('returns [] when args is unset', async () => {
    const args = await loadConstructorArgs(baseContract(), '/tmp');
    expect(args).toEqual([]);
  });

  it('passes inline arrays through', async () => {
    const args = await loadConstructorArgs(
      baseContract({ args: ['MyToken', 'MTK', 18] }),
      '/tmp',
    );
    expect(args).toEqual(['MyToken', 'MTK', 18]);
  });

  it('reads a JSON file ref and revives bigints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'args-test-'));
    writeFileSync(join(dir, 'a.json'), '["x", "100n"]');
    const args = await loadConstructorArgs(
      baseContract({ args: { file: 'a.json' } }),
      dir,
    );
    expect(args).toEqual(['x', 100n]);
  });

  it('parses a --args override JSON string', async () => {
    const args = await loadConstructorArgs(baseContract(), '/tmp', '[1,2,3]');
    expect(args).toEqual([1, 2, 3]);
  });

  it('rejects a non-array --args override', async () => {
    await expect(
      loadConstructorArgs(baseContract(), '/tmp', '{"x":1}'),
    ).rejects.toThrow(ConfigError);
  });
});
