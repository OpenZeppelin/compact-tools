import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContractConfig } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import { ConstructorArgs } from './args.ts';

function makeFakeArtifact(paramSig: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'args-artifact-'));
  mkdirSync(join(dir, 'contract'));
  writeFileSync(
    join(dir, 'contract', 'index.d.ts'),
    [
      "import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';",
      'export declare class Contract<PS = any> {',
      '  initialState(context: __compactRuntime.ConstructorContext<PS>,',
      `               ${paramSig}): __compactRuntime.ConstructorResult<PS>;`,
      '}',
      '',
    ].join('\n'),
  );
  return dir;
}

const baseContract = (extra: Partial<ContractConfig> = {}): ContractConfig =>
  ({
    artifact: 'x',
    signing_key_file: 'x.sk',
    ...extra,
  }) as ContractConfig;

describe('ConstructorArgs', () => {
  it('should return empty values when args is unset', async () => {
    const args = await ConstructorArgs.load(baseContract(), '/tmp');
    expect(args.values).toEqual([]);
    expect(args.source).toBe('empty');
  });

  it('should pass inline arrays through', async () => {
    const args = await ConstructorArgs.load(
      baseContract({ args: ['MyToken', 'MTK', 18] }),
      '/tmp',
    );
    expect(args.values).toEqual(['MyToken', 'MTK', 18]);
    expect(args.source).toBe('inline');
  });

  it('should read a JSON file ref and revive bigints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'args-test-'));
    writeFileSync(join(dir, 'a.json'), '["x", "100n"]');
    const args = await ConstructorArgs.load(
      baseContract({ args: { file: 'a.json' } }),
      dir,
    );
    expect(args.values).toEqual(['x', 100n]);
    expect(args.source).toBe('file');
  });

  it('should parse a --args override JSON string', async () => {
    const args = await ConstructorArgs.load(baseContract(), '/tmp', '[1,2,3]');
    expect(args.values).toEqual([1, 2, 3]);
    expect(args.source).toBe('cli');
  });

  it('should reject a non-array --args override', async () => {
    await expect(
      ConstructorArgs.load(baseContract(), '/tmp', '{"x":1}'),
    ).rejects.toThrow(ConfigError);
  });

  it('should resolve a { module, export } ref to an exported array', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'args-test-'));
    writeFileSync(join(dir, 'm.mjs'), 'export const values = [1, "two", 3n];');
    const args = await ConstructorArgs.load(
      baseContract({ args: { module: 'm.mjs', export: 'values' } }),
      dir,
    );
    expect(args.values).toEqual([1, 'two', 3n]);
    expect(args.source).toBe('module');
  });

  it('should reject a { module, export } ref whose export is not an array', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'args-test-'));
    writeFileSync(join(dir, 'm.mjs'), 'export const notArr = { a: 1 };');
    await expect(
      ConstructorArgs.load(
        baseContract({ args: { module: 'm.mjs', export: 'notArr' } }),
        dir,
      ),
    ).rejects.toThrow(/must be an array/);
  });

  it('should use programmatic apiArgs and win over every other source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'args-test-'));
    writeFileSync(join(dir, 'a.json'), '["from-file"]');
    const args = await ConstructorArgs.load(
      baseContract({ args: { file: 'a.json' } }),
      dir,
      '["from-cli"]',
      ['from-api', 42n, new Uint8Array([0xab])],
    );
    expect(args.values).toEqual(['from-api', 42n, new Uint8Array([0xab])]);
    expect(args.source).toBe('api');
  });

  it('should accept an empty apiArgs array', async () => {
    const args = await ConstructorArgs.load(
      baseContract(),
      '/tmp',
      undefined,
      [],
    );
    expect(args.values).toEqual([]);
    expect(args.source).toBe('api');
  });

  it('should reject a { file } ref containing malformed JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'args-test-'));
    writeFileSync(join(dir, 'bad.json'), 'not json');
    await expect(
      ConstructorArgs.load(baseContract({ args: { file: 'bad.json' } }), dir),
    ).rejects.toThrow(/invalid JSON at/);
  });

  it('should reorder a named-object apiArgs to match the artifact constructor', async () => {
    const artifactPath = makeFakeArtifact(
      '_name_2: string, _decimals_2: bigint, _isMintable_0: boolean',
    );
    const args = await ConstructorArgs.load(
      baseContract(),
      '/tmp',
      undefined,
      { _isMintable: true, _name: 'OZE', _decimals: 18n },
      artifactPath,
    );
    expect(args.values).toEqual(['OZE', 18n, true]);
    expect(args.source).toBe('api');
  });

  it('should reject a named-object apiArgs missing a constructor parameter', async () => {
    const artifactPath = makeFakeArtifact(
      '_name_2: string, _decimals_2: bigint',
    );
    await expect(
      ConstructorArgs.load(
        baseContract(),
        '/tmp',
        undefined,
        { _name: 'OZE' },
        artifactPath,
      ),
    ).rejects.toThrow(/missing constructor parameter\(s\): _decimals/);
  });

  it('should reject a named-object apiArgs with unknown keys', async () => {
    const artifactPath = makeFakeArtifact('_name_2: string');
    await expect(
      ConstructorArgs.load(
        baseContract(),
        '/tmp',
        undefined,
        { _name: 'OZE', _bogus: 1 },
        artifactPath,
      ),
    ).rejects.toThrow(/unknown constructor parameter\(s\): _bogus/);
  });

  it('should reject a named-object apiArgs when artifactPath is missing', async () => {
    await expect(
      ConstructorArgs.load(baseContract(), '/tmp', undefined, { foo: 1 }),
    ).rejects.toThrow(/named-object args require the artifact path/);
  });
});
