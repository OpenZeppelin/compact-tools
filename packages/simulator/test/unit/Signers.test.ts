import { describe, expect, it } from 'vitest';
import { MAX_LIVE_SIGNERS, Signers } from '../../src/signers/Signers.js';

/** The existing harness's alias derivation, reproduced for the parity check. */
const expectedDryKey = (alias: string): string =>
  Buffer.from(alias, 'ascii').toString('hex').padStart(64, '0');

describe('Signers — dry derivation', () => {
  const signers = new Signers({ mode: 'dry' });

  it('derives the same key the existing test harness uses', async () => {
    expect(await signers.keyFor('OWNER')).toEqual(expectedDryKey('OWNER'));
    expect(signers.resolveDryKey('OWNER')).toEqual(expectedDryKey('OWNER'));
  });

  it('honors an explicit alias→key override', async () => {
    const custom = new Signers({
      mode: 'dry',
      dryKeys: { OWNER: 'ff'.repeat(32) },
    });
    expect(await custom.keyFor('OWNER')).toEqual('ff'.repeat(32));
    // Unmapped aliases fall back to the default derivation.
    expect(await custom.keyFor('ALICE')).toEqual(expectedDryKey('ALICE'));
  });

  it('wraps the key in a left-variant Either for circuit args', async () => {
    const either = await signers.eitherFor('OWNER');
    expect(either.is_left).toBe(true);
    expect(either.left.bytes).toBeInstanceOf(Uint8Array);
  });
});

describe('Signers — live cap', () => {
  it(`allows up to ${MAX_LIVE_SIGNERS} prefunded aliases`, () => {
    expect(
      () =>
        new Signers({
          mode: 'live',
          liveAliases: ['DEPLOYER', 'OWNER', 'ALICE', 'BOB'],
        }),
    ).not.toThrow();
  });

  it('rejects a pool larger than the cap at construction', () => {
    expect(
      () =>
        new Signers({
          mode: 'live',
          liveAliases: ['DEPLOYER', 'OWNER', 'ALICE', 'BOB', 'CAROL'],
        }),
    ).toThrow(`at most ${MAX_LIVE_SIGNERS}`);
  });

  it('rejects an alias outside the pool, never silently reusing a wallet', () => {
    const signers = new Signers({ mode: 'live', liveAliases: ['OWNER'] });
    expect(() => signers.assertLiveAliasAllowed('STRANGER')).toThrow(
      'not in the prefunded pool',
    );
    expect(() => signers.assertLiveAliasAllowed('OWNER')).not.toThrow();
  });

  it('is a no-op in dry mode', () => {
    const signers = new Signers({ mode: 'dry' });
    expect(() => signers.assertLiveAliasAllowed('ANYONE')).not.toThrow();
  });
});
