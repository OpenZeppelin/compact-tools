import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { ConfigError, FragmentDeployError } from '../errors.ts';
import {
  type ArtifactKeys,
  assertResumable,
  awaitCircuitsOnChain,
  type ChainSnapshot,
  readSnapshot,
  signerIndex,
  verifyState,
} from './chain-state.ts';

const ADDRESS = 'cd'.repeat(32);
const OUR_KEY = 'our-verifying-key';

function keys(entries: Record<string, number[]>): ArtifactKeys {
  return new Map(
    Object.entries(entries).map(([name, bytes]) => [
      name,
      new Uint8Array(bytes),
    ]),
  );
}

const ARTIFACT = keys({ approve: [1, 2, 3], burn: [4, 5, 6] });

function snapshot(overrides: Partial<ChainSnapshot> = {}): ChainSnapshot {
  return {
    circuits: ['approve', 'burn'],
    verifierKeys: keys({ approve: [1, 2, 3], burn: [4, 5, 6] }),
    counter: 2n,
    committee: [OUR_KEY],
    threshold: 1,
    ...overrides,
  };
}

/** Ledger-shaped state stub: only what `readSnapshot` reads. */
function stateStub(
  operations: Record<string, number[]>,
  authority = { committee: [OUR_KEY], threshold: 1, counter: 3n },
) {
  return {
    operations: () => Object.keys(operations),
    operation: (name: string) => {
      const bytes = operations[name];
      return bytes === undefined
        ? undefined
        : { verifierKey: new Uint8Array(bytes) };
    },
    maintenanceAuthority: authority,
  };
}

function provider(queryContractState: Mock): PublicDataProvider {
  return { queryContractState } as unknown as PublicDataProvider;
}

describe('readSnapshot', () => {
  it('reads operations, keys, counter and committee', async () => {
    const read = await readSnapshot(
      provider(vi.fn(async () => stateStub({ burn: [4], approve: [1] }))),
      ADDRESS,
    );

    expect(read?.circuits).toStrictEqual(['approve', 'burn']);
    expect(read?.verifierKeys.get('burn')).toStrictEqual(new Uint8Array([4]));
    expect(read?.counter).toBe(3n);
    expect(read?.committee).toStrictEqual([OUR_KEY]);
    expect(read?.threshold).toBe(1);
  });

  // INV-27(a)
  it('returns undefined when no contract exists at the address', async () => {
    expect(
      await readSnapshot(provider(vi.fn(async () => null)), ADDRESS),
    ).toBeUndefined();
  });

  it('skips an operation the state cannot return', async () => {
    const stub = stateStub({ approve: [1] });
    const read = await readSnapshot(
      provider(
        vi.fn(async () => ({
          ...stub,
          operations: () => ['approve', 'ghost'],
        })),
      ),
      ADDRESS,
    );

    expect(read?.circuits).toStrictEqual(['approve', 'ghost']);
    expect(read?.verifierKeys.has('ghost')).toBe(false);
  });
});

describe('awaitCircuitsOnChain', () => {
  // INV-13
  it('re-reads until the landed fragment is visible', async () => {
    const queryContractState = vi
      .fn()
      .mockResolvedValueOnce(stateStub({ approve: [1] }))
      .mockResolvedValueOnce(stateStub({ approve: [1], burn: [4] }));

    const read = await awaitCircuitsOnChain({
      publicDataProvider: provider(queryContractState),
      address: ADDRESS,
      expected: ['burn'],
      timeoutMs: 1_000,
      pollMs: 1,
    });

    expect(queryContractState).toHaveBeenCalledTimes(2);
    expect(read.circuits).toStrictEqual(['approve', 'burn']);
  });

  // INV-13
  it('fails with the pending circuits when the state never catches up', async () => {
    const thrown = await awaitCircuitsOnChain({
      publicDataProvider: provider(
        vi.fn(async () => stateStub({ approve: [1] })),
      ),
      address: ADDRESS,
      expected: ['burn'],
      timeoutMs: 5,
      pollMs: 1,
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect((thrown as FragmentDeployError).circuitsPending).toStrictEqual([
      'burn',
    ]);
    expect((thrown as FragmentDeployError).circuitsOnChain).toStrictEqual([
      'approve',
    ]);
  });

  // INV-13
  it('reports every expected circuit as pending when the address is empty', async () => {
    const thrown = await awaitCircuitsOnChain({
      publicDataProvider: provider(vi.fn(async () => null)),
      address: ADDRESS,
      expected: ['approve', 'burn'],
      timeoutMs: 5,
      pollMs: 1,
    }).catch((e: unknown) => e);

    expect((thrown as FragmentDeployError).circuitsPending).toStrictEqual([
      'approve',
      'burn',
    ]);
  });
});

/** The authority the deploy read before its first insert. */
const AUTHORITY = { committee: [OUR_KEY], threshold: 1 };

describe('verifyState', () => {
  // INV-11
  it('passes on an exact match', () => {
    expect(() =>
      verifyState({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: snapshot(),
        authority: AUTHORITY,
      }),
    ).not.toThrow();
  });

  // INV-11
  it('fails on a single flipped verifier-key byte', () => {
    const thrown = catchThrown(() =>
      verifyState({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: snapshot({
          verifierKeys: keys({ approve: [1, 2, 3], burn: [4, 5, 7] }),
        }),
        authority: AUTHORITY,
      }),
    );

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect((thrown as Error).message).toContain(
      '"burn" has a different verifier key on chain',
    );
  });

  // INV-11
  it('fails on a missing circuit', () => {
    const thrown = catchThrown(() =>
      verifyState({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: snapshot({
          circuits: ['approve'],
          verifierKeys: keys({ approve: [1, 2, 3] }),
        }),
        authority: AUTHORITY,
      }),
    );

    expect((thrown as Error).message).toContain('"burn" is missing on chain');
    expect((thrown as FragmentDeployError).circuitsPending).toStrictEqual([
      'burn',
    ]);
  });

  // INV-11
  it('fails on an on-chain circuit the artifact does not have', () => {
    const thrown = catchThrown(() =>
      verifyState({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: snapshot({
          circuits: ['approve', 'burn', 'stranger'],
          verifierKeys: keys({
            approve: [1, 2, 3],
            burn: [4, 5, 6],
            stranger: [9],
          }),
        }),
        authority: AUTHORITY,
      }),
    );

    expect((thrown as Error).message).toContain(
      '"stranger" is on chain but not in the artifact',
    );
  });

  // INV-11
  it('fails when the chain reports a circuit with no key bytes', () => {
    const thrown = catchThrown(() =>
      verifyState({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: snapshot({ verifierKeys: keys({ approve: [1, 2, 3] }) }),
        authority: AUTHORITY,
      }),
    );

    expect((thrown as Error).message).toContain(
      '"burn" has a different verifier key on chain',
    );
  });

  // INV-15
  it.each([
    ['committee', snapshot({ committee: [OUR_KEY, 'newcomer'] })],
    ['threshold', snapshot({ threshold: 2 })],
    ['membership', snapshot({ committee: ['someone-else'] })],
  ])('refuses a %s that moved during the deploy', (_label, chain) => {
    const thrown = catchThrown(() =>
      verifyState({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: chain,
        authority: AUTHORITY,
      }),
    );

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain('Maintenance authority of');
  });
});

describe('signerIndex', () => {
  // INV-25
  it('returns this key slot in the committee', () => {
    const chain = snapshot({ committee: ['someone-else', OUR_KEY] });

    expect(
      signerIndex({ address: ADDRESS, snapshot: chain, verifyingKey: OUR_KEY }),
    ).toBe(1);
  });

  // INV-25
  it('refuses a committee that needs more than one signature', () => {
    const thrown = catchThrown(() =>
      signerIndex({
        address: ADDRESS,
        snapshot: snapshot({ threshold: 2 }),
        verifyingKey: OUR_KEY,
      }),
    );

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain(
      'needs 2 maintenance signatures',
    );
  });

  // INV-25
  it('refuses a committee this key is not in', () => {
    const thrown = catchThrown(() =>
      signerIndex({
        address: ADDRESS,
        snapshot: snapshot({ committee: ['someone-else'] }),
        verifyingKey: OUR_KEY,
      }),
    );

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain(
      'not maintained by this signing key',
    );
  });
});

describe('assertResumable', () => {
  // INV-27
  it('returns the snapshot when address, committee and keys all check out', () => {
    const chain = snapshot({
      circuits: ['approve'],
      verifierKeys: keys({ approve: [1, 2, 3] }),
    });

    expect(
      assertResumable({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: chain,
        verifyingKey: OUR_KEY,
      }),
    ).toBe(chain);
  });

  // INV-27(a)
  it('refuses a record pointing at an address with no contract', () => {
    const thrown = catchThrown(() =>
      assertResumable({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: undefined,
        verifyingKey: OUR_KEY,
      }),
    );

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain('no contract exists there');
  });

  // INV-25
  it('refuses a resume onto a multi-signer committee', () => {
    const thrown = catchThrown(() =>
      assertResumable({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: snapshot({ threshold: 3, committee: [OUR_KEY, 'a', 'b'] }),
        verifyingKey: OUR_KEY,
      }),
    );

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain(
      'needs 3 maintenance signatures',
    );
  });

  // INV-27(b)
  it('refuses a contract maintained by someone else', () => {
    const thrown = catchThrown(() =>
      assertResumable({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: snapshot({ committee: ['someone-else'] }),
        verifyingKey: OUR_KEY,
      }),
    );

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain(
      'not maintained by this signing key',
    );
  });

  // INV-27(c)
  it('refuses a contract carrying a key from a different build', () => {
    const thrown = catchThrown(() =>
      assertResumable({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: snapshot({
          circuits: ['approve'],
          verifierKeys: keys({ approve: [9, 9, 9] }),
        }),
        verifyingKey: OUR_KEY,
      }),
    );

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain('a different build');
  });

  // INV-27(c)
  it('refuses a contract with a circuit the artifact no longer has', () => {
    const thrown = catchThrown(() =>
      assertResumable({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: snapshot({
          circuits: ['approve', 'renamed'],
          verifierKeys: keys({ approve: [1, 2, 3], renamed: [7] }),
        }),
        verifyingKey: OUR_KEY,
      }),
    );

    expect((thrown as Error).message).toContain(
      '"renamed" is on chain but not in the artifact',
    );
  });

  // INV-27
  it('accepts a partial deploy without demanding the pending circuits', () => {
    expect(() =>
      assertResumable({
        address: ADDRESS,
        artifactKeys: ARTIFACT,
        snapshot: snapshot({ circuits: [], verifierKeys: keys({}) }),
        verifyingKey: OUR_KEY,
      }),
    ).not.toThrow();
  });
});

function catchThrown(body: () => unknown): unknown {
  try {
    body();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}
