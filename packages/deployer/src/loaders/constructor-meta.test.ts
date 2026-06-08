import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors.ts';
import {
  parseConstructorParamNames,
  reorderNamedArgs,
} from './constructor-meta.ts';

const dts = (params: string) =>
  [
    "import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';",
    'export declare class Contract<PS = any> {',
    '  initialState(context: __compactRuntime.ConstructorContext<PS>,',
    `               ${params}): __compactRuntime.ConstructorResult<PS>;`,
    '}',
  ].join('\n');

describe('parseConstructorParamNames', () => {
  it('strips the trailing SSA suffix the compiler appends', () => {
    expect(
      parseConstructorParamNames(
        dts('_name_2: string, _symbol_2: string, init_0: boolean'),
      ),
    ).toEqual(['_name', '_symbol', 'init']);
  });

  it('handles generics with commas inside angle brackets', () => {
    expect(
      parseConstructorParamNames(
        dts('owner_0: Either<Uint8Array, ContractAddress>, isInit_0: boolean'),
      ),
    ).toEqual(['owner', 'isInit']);
  });

  it('handles Vector / array types', () => {
    expect(
      parseConstructorParamNames(
        dts(
          'salt_0: Uint8Array, commitments_0: Uint8Array[], thresh_0: bigint',
        ),
      ),
    ).toEqual(['salt', 'commitments', 'thresh']);
  });

  it('keeps the SSA suffix when stripping would cause a name collision', () => {
    expect(
      parseConstructorParamNames(dts('foo_0: bigint, foo_1: bigint')),
    ).toEqual(['foo_0', 'foo_1']);
  });

  it('returns [] for a no-arg constructor', () => {
    expect(parseConstructorParamNames(dts(''))).toEqual([]);
  });

  it('returns [] when initialState is not present', () => {
    expect(parseConstructorParamNames('// nothing here')).toEqual([]);
  });
});

describe('reorderNamedArgs', () => {
  it('maps a named record to the positional tuple', () => {
    expect(reorderNamedArgs({ b: 2, a: 1, c: 3 }, ['a', 'b', 'c'])).toEqual([
      1, 2, 3,
    ]);
  });

  it('rejects when a required name is missing', () => {
    expect(() => reorderNamedArgs({ a: 1 }, ['a', 'b'])).toThrow(ConfigError);
  });

  it('rejects when an extra unknown name is present', () => {
    expect(() => reorderNamedArgs({ a: 1, x: 9 }, ['a'])).toThrow(
      /unknown constructor parameter\(s\): x/,
    );
  });

  it('accepts an empty named object for a no-arg constructor', () => {
    expect(reorderNamedArgs({}, [])).toEqual([]);
  });

  it('rejects a non-empty named object for a no-arg constructor', () => {
    expect(() => reorderNamedArgs({ a: 1 }, [])).toThrow(
      /unknown constructor parameter\(s\): a/,
    );
  });
});
