import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.ts';
import { indexSources, keyKind, resolveEntry, sourceOf } from './patterns.ts';
import type { ContractEntry } from './schema.ts';

function srcTree(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'compact-src-'));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), '');
  }
  return dir;
}

describe('keyKind', () => {
  it.each(['Token', 'my-token', 'Token.v2'])(
    'should classify %s as exact',
    (key) => {
      expect(keyKind(key)).toBe('exact');
    },
  );

  it.each(['Mock*', 'Mock?', 'Mock[AB]', '{Token,Vault}'])(
    'should classify %s as a name pattern',
    (key) => {
      expect(keyKind(key)).toBe('name');
    },
  );

  it.each(['multisig/**', '**/test/mocks/*', 'token/Token.compact'])(
    'should classify %s as a directory pattern',
    (key) => {
      expect(keyKind(key)).toBe('directory');
    },
  );
});

describe('resolveEntry', () => {
  it('should return undefined when no key applies', () => {
    expect(
      resolveEntry('Vault', { Token: {}, 'Mock*': {} }, undefined),
    ).toBeUndefined();
  });

  it('should match a name pattern against the contract name', () => {
    const contracts = { 'Mock*': {}, 'token/*': {} };
    expect(
      resolveEntry('MockToken', contracts, 'access/MockToken.compact')?.keys,
    ).toEqual(['Mock*']);
  });

  it('should match a directory pattern against the source path, extension included', () => {
    const contracts = {
      '**/mocks/*.compact': {},
      'mocks/**': {},
      '**/*.ts': {},
    };
    expect(
      resolveEntry('MockToken', contracts, 'token/mocks/MockToken.compact')
        ?.keys,
    ).toEqual(['**/mocks/*.compact']);
  });

  it('should ignore a leading ./ on a directory pattern', () => {
    expect(
      resolveEntry(
        'MockToken',
        { './token/**': {} },
        'token/mocks/MockToken.compact',
      )?.keys,
    ).toEqual(['./token/**']);
  });

  it('should skip directory patterns for a contract with no source', () => {
    expect(
      resolveEntry('MockToken', { '**/*': {} }, undefined),
    ).toBeUndefined();
  });

  it('should apply patterns in file order and the exact key last', () => {
    const contracts: Record<string, ContractEntry> = {
      Token: { args: [3] },
      '*': { signing_key_file: 'a.sk', args: [1], private_state_id: 'a' },
      'Tok*': { signing_key_file: 'b.sk', args: [2] },
    };
    const resolved = resolveEntry('Token', contracts, undefined);
    expect(resolved?.keys).toEqual(['*', 'Tok*', 'Token']);
    expect(resolved?.entry).toEqual({
      artifact: 'Token',
      signing_key_file: 'b.sk',
      args: [3],
      private_state_id: 'a',
    });
  });

  it('should replace a ref field whole', () => {
    const resolved = resolveEntry(
      'Token',
      {
        '*': { witnesses: { module: 'witnesses.ts', export: 'witnesses' } },
        Token: { witnesses: { file: 'witnesses.json' } },
      },
      undefined,
    );
    expect(resolved?.entry.witnesses).toEqual({ file: 'witnesses.json' });
  });

  it('should never apply a pattern key as the exact key', () => {
    expect(
      resolveEntry('Mock*', { 'Mock*': { args: [1] } }, undefined)?.keys,
    ).toEqual(['Mock*']);
  });

  it('should default artifact to the contract name', () => {
    expect(resolveEntry('Token', { Token: {} }, undefined)?.entry).toEqual({
      artifact: 'Token',
    });
    expect(
      resolveEntry('Token', { Token: { artifact: 'out/Token' } }, undefined)
        ?.entry.artifact,
    ).toBe('out/Token');
  });

  it('should expand {name} in every string value', () => {
    const genesis = new Date(0);
    const entry = resolveEntry(
      'Token',
      {
        '*': {
          artifact: 'build/{name}',
          signing_key_file: 'keys/{name}.sk',
          private_state_id: '{name}State',
          private_state_store_name: '{name}-store',
          init_private_state: { file: 'state/{name}.json' },
          witnesses: {
            module: 'witnesses/{name}.ts',
            export: '{name}Witnesses',
          },
          args: ['{name}', 18, { label: '{name}/{name}' }, genesis],
        },
      },
      undefined,
    )?.entry;
    expect(entry).toEqual({
      artifact: 'build/Token',
      signing_key_file: 'keys/Token.sk',
      private_state_id: 'TokenState',
      private_state_store_name: 'Token-store',
      init_private_state: { file: 'state/Token.json' },
      witnesses: { module: 'witnesses/Token.ts', export: 'TokenWitnesses' },
      args: ['Token', 18, { label: 'Token/Token' }, genesis],
    });
    expect((entry?.args as unknown[] | undefined)?.[3]).toBe(genesis);
  });

  it('should leave the input entries untouched', () => {
    const contracts = {
      '*': { signing_key_file: '{name}.sk', args: ['{name}'] },
    };
    resolveEntry('Token', contracts, undefined);
    expect(contracts['*']).toEqual({
      signing_key_file: '{name}.sk',
      args: ['{name}'],
    });
  });
});

describe('indexSources / sourceOf', () => {
  it('should find a source by contract name at any depth', async () => {
    const index = await indexSources(
      srcTree(['token/test/mocks/MockToken.compact', 'Top.compact']),
    );
    expect(sourceOf('MockToken', index)).toBe(
      'token/test/mocks/MockToken.compact',
    );
    expect(sourceOf('Top', index)).toBe('Top.compact');
    expect(sourceOf('Vault', index)).toBeUndefined();
  });

  it('should index only .compact files outside node_modules and dot-directories', async () => {
    const index = await indexSources(
      srcTree([
        'token/Token.compact',
        'node_modules/dep/Dep.compact',
        'token/node_modules/Nested.compact',
        '.cache/Hidden.compact',
        'Vault.compact.bak',
        'Vault.ts',
      ]),
    );
    expect([...index.byName]).toEqual([['Token', ['token/Token.compact']]]);
  });

  it('should throw ConfigError naming every source of an ambiguous name', async () => {
    const dir = srcTree(['b/Token.compact', 'a/Token.compact']);
    const index = await indexSources(dir);
    expect(() => sourceOf('Token', index)).toThrow(ConfigError);
    expect(() => sourceOf('Token', index)).toThrow(
      `Contract "Token" matches 2 sources under ${dir}: a/Token.compact, b/Token.compact`,
    );
  });

  it('should throw ConfigError when the directory does not exist', async () => {
    const missing = join(tmpdir(), `no-compact-src-${Date.now()}`);
    await expect(indexSources(missing)).rejects.toThrow(ConfigError);
    await expect(indexSources(missing)).rejects.toThrow(
      `[profile].src_dir is not a directory: ${missing}`,
    );
  });
});
