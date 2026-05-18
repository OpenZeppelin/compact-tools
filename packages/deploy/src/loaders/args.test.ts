import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContractConfig } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import { ConstructorArgs } from './args.ts';

const baseContract = (extra: Partial<ContractConfig> = {}): ContractConfig =>
  ({
    artifact: 'x',
    signing_key_file: 'x.sk',
    ...extra,
  }) as ContractConfig;

describe('ConstructorArgs', () => {
  it('returns empty values when args is unset', async () => {
    const args = await ConstructorArgs.load(baseContract(), '/tmp');
    expect(args.values).toEqual([]);
    expect(args.source).toBe('empty');
  });

  it('passes inline arrays through', async () => {
    const args = await ConstructorArgs.load(
      baseContract({ args: ['MyToken', 'MTK', 18] }),
      '/tmp',
    );
    expect(args.values).toEqual(['MyToken', 'MTK', 18]);
    expect(args.source).toBe('inline');
  });

  it('reads a JSON file ref and revives bigints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'args-test-'));
    writeFileSync(join(dir, 'a.json'), '["x", "100n"]');
    const args = await ConstructorArgs.load(
      baseContract({ args: { file: 'a.json' } }),
      dir,
    );
    expect(args.values).toEqual(['x', 100n]);
    expect(args.source).toBe('file');
  });

  it('parses a --args override JSON string', async () => {
    const args = await ConstructorArgs.load(baseContract(), '/tmp', '[1,2,3]');
    expect(args.values).toEqual([1, 2, 3]);
    expect(args.source).toBe('cli');
  });

  it('rejects a non-array --args override', async () => {
    await expect(
      ConstructorArgs.load(baseContract(), '/tmp', '{"x":1}'),
    ).rejects.toThrow(ConfigError);
  });
});
