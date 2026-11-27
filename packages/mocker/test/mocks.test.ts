import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CompactTypeBytes,
  CompactTypeField,
  CompactTypeVector,
  persistentHash,
} from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';
import { binaryUnderTest } from './binaryUnderTest.ts';
import type { Account, Caller } from './fixtureMocks.ts';
import { FIXTURES } from './setup.ts';

const { skip } = binaryUnderTest(process.env, existsSync);
const skipped = skip !== undefined;
const title = (name: string) => (skipped ? `${name} (skipped: ${skip})` : name);

// Typed as loaded: when skipped no test body runs, so nothing reads it.
const fx = (
  skipped ? {} : await import('./fixtureMocks.ts')
) as typeof import('./fixtureMocks.ts');

const ZERO = new Uint8Array(32);

/** `pad(32, text)`: the UTF-8 bytes, zero-filled to 32. */
function pad32(text: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(text));
  return out;
}

function keyAccount(bytes: Uint8Array): Account {
  return { is_left: true, left: bytes, right: { bytes: ZERO } };
}

/** `Pseudonym.derive(secretKey, salt)`, computed without the contract. */
function pseudonym(secretKey: Uint8Array, salt: string | Uint8Array): Account {
  return keyAccount(
    persistentHash(new CompactTypeVector(2, new CompactTypeBytes(32)), [
      secretKey,
      typeof salt === 'string' ? pad32(salt) : salt,
    ]),
  );
}

/** `Keyed.authenticateHere()`'s account: the key under the fixed salt `keyed`. */
const keyed = (secretKey: Uint8Array) => pseudonym(secretKey, 'keyed');

const caller = (account: Account): Caller => ({ account });

const ALICE = pad32('alice secret key');
const BOB = pad32('bob secret key');

const circuitNames = (contract: { circuits: object }): string[] =>
  Object.keys(contract.circuits).sort();

const artifactDir = (dir: string, mock: string) =>
  join(FIXTURES, 'src', dir, 'test', 'artifacts', mock);

describe.skipIf(skipped)(title('the fixture mocks'), () => {
  it('expose exactly the configured circuits', () => {
    const pseudonymWitnesses = fx.pseudonymWitnesses();
    const keyedWitnesses = fx.keyedWitnesses();
    const shieldedWitnesses = fx.shieldedWitnesses();
    const owned = ['assertOnlyOwner', 'owner', 'setPair', 'transferOwnership'];

    expect(circuitNames(new fx.MockOwned(pseudonymWitnesses))).toEqual(owned);
    expect(circuitNames(new fx.MockOwnedKeyed(keyedWitnesses))).toEqual(owned);
    expect(circuitNames(new fx.MockOwnedCaller({}))).toEqual(owned);
    expect(circuitNames(new fx.MockClaimed(pseudonymWitnesses))).toEqual([]);
    expect(circuitNames(new fx.MockClaimedFlag(pseudonymWitnesses))).toEqual(
      [],
    );
    expect(circuitNames(new fx.MockShielded(shieldedWitnesses))).toEqual([
      'commitment',
      'isMember',
      'join',
    ]);
    expect(circuitNames(new fx.MockShieldedCaller({}))).toEqual([
      'commitment',
      'isMember',
      'join',
    ]);
    expect(circuitNames(new fx.MockPseudonym(pseudonymWitnesses))).toEqual([
      'authenticate',
      'derive',
    ]);
    expect(circuitNames(new fx.MockClicker({}))).toEqual([
      'bump',
      'reset',
      'total',
    ]);
    expect(circuitNames(new fx.MockHash({}))).toEqual([
      'digest',
      'mix',
      'seeded',
      'square',
      'twice',
    ]);
    expect(circuitNames(new fx.MockBag({}))).toEqual([
      'capacity',
      'first',
      'put',
    ]);
    expect(circuitNames(new fx.MockBagNoInit({}))).toEqual([
      'capacity',
      'first',
      'initialize',
      'put',
    ]);
    expect(circuitNames(new fx.MockBagPair({}))).toEqual([
      'B2_capacity',
      'B3_capacity',
      'capacity2',
      'capacity3',
      'put2',
      'put3',
    ]);
    expect(circuitNames(new fx.MockScale({}))).toEqual([
      'mix',
      'mixPair',
      'scale',
      'scale2',
    ]);
  });

  it('are written beside their compiled output under each test/artifacts directory', () => {
    expect(
      readdirSync(join(FIXTURES, 'src', 'access', 'test', 'artifacts')).sort(),
    ).toEqual([
      '.compact-mock-stamp',
      'MockClaimed',
      'MockClaimed.compact',
      'MockClaimedFlag',
      'MockClaimedFlag.compact',
      'MockOwned',
      'MockOwned.compact',
      'MockOwnedCaller',
      'MockOwnedCaller.compact',
      'MockOwnedKeyed',
      'MockOwnedKeyed.compact',
      'MockShielded',
      'MockShielded.compact',
      'MockShieldedCaller',
      'MockShieldedCaller.compact',
    ]);
    expect(existsSync(join(FIXTURES, 'src', 'identity', 'test'))).toBe(false);
    expect(existsSync(join(FIXTURES, 'src', 'presets', 'test'))).toBe(false);
    expect(existsSync(join(FIXTURES, 'src', 'rand', 'test'))).toBe(false);
  });
});

describe.skipIf(skipped)(title('MockOwned'), () => {
  const create = (owner: Account, isInit: boolean, secretKey = ALICE) =>
    fx.OwnedSimulator.create([owner, isInit], { privateState: { secretKey } });

  it('passes an authenticated call for the secret behind the owner', async () => {
    const sim = await create(pseudonym(ALICE, 'MockOwned'), true);

    await expect(sim.assertOnlyOwner()).resolves.toEqual([]);
  });

  it('fails an authenticated call for another secret', async () => {
    const sim = await create(pseudonym(ALICE, 'MockOwned'), true, BOB);

    await expect(sim.assertOnlyOwner()).rejects.toThrow(
      'Owned: caller is not the owner',
    );
  });

  it('derives the caller under the mock name as salt', async () => {
    const sim = await create(pseudonym(ALICE, 'MockOwnedCaller'), true);

    await expect(sim.assertOnlyOwner()).rejects.toThrow(
      'Owned: caller is not the owner',
    );
  });

  it('passes the injected caller at its parameter position', async () => {
    const sim = await create(pseudonym(ALICE, 'MockOwned'), true);

    await sim.setPair(1n, 2n);

    const state = await sim.getPublicState();
    expect(state.Owned__tag).toBe(1n);
    expect(state.Owned__value).toBe(2n);
  });

  it('shares one module instance between wrappers, re-exports and ledger exports', async () => {
    const sim = await create(pseudonym(ALICE, 'MockOwned'), true);
    const next = keyAccount(pad32('next owner'));

    await sim.transferOwnership(next);

    expect(await sim.owner()).toEqual(next);
    expect((await sim.getPublicState()).Owned__owner).toEqual(next);
  });

  it('leaves the module uninitialized when isInit is false', async () => {
    const sim = await create(pseudonym(ALICE, 'MockOwned'), false);

    await expect(sim.owner()).rejects.toThrow('Owned: not initialized');
    expect((await sim.getPublicState()).Owned__initialized).toBe(false);
  });

  it('exports the module ledger fields under the module prefix', async () => {
    const sim = await create(pseudonym(ALICE, 'MockOwned'), true);

    expect(Object.keys(await sim.getPublicState()).sort()).toEqual([
      'Owned__initialized',
      'Owned__owner',
      'Owned__tag',
      'Owned__value',
    ]);
  });
});

describe.skipIf(skipped)(title('MockOwnedKeyed'), () => {
  const create = (owner: Account, secretKey = ALICE) =>
    fx.OwnedKeyedSimulator.create([owner], { privateState: { secretKey } });

  it('passes a call authenticated by the authenticator that takes no salt', async () => {
    const sim = await create(keyed(ALICE));

    await expect(sim.assertOnlyOwner()).resolves.toEqual([]);
  });

  it('fails a call for another secret', async () => {
    const sim = await create(keyed(ALICE), BOB);

    await expect(sim.assertOnlyOwner()).rejects.toThrow(
      'Owned: caller is not the owner',
    );
  });

  it('ignores the mock-name salt', async () => {
    const sim = await create(pseudonym(ALICE, 'MockOwnedKeyed'));

    await expect(sim.assertOnlyOwner()).rejects.toThrow(
      'Owned: caller is not the owner',
    );
  });

  it('initializes in a plain constructor and needs only its own witness', async () => {
    const sim = await create(keyed(ALICE));

    expect(await sim.owner()).toEqual(keyed(ALICE));
    expect(() => new fx.MockOwnedKeyed(fx.keyedWitnesses())).not.toThrow();
    expect(
      () =>
        new fx.MockOwnedKeyed(
          fx.pseudonymWitnesses() as unknown as ReturnType<
            typeof fx.keyedWitnesses
          >,
        ),
    ).toThrow('wit_KeyedSK');
  });
});

describe.skipIf(skipped)(title('MockOwnedCaller'), () => {
  const owner = keyAccount(pad32('owner'));

  it('takes the caller as an argument', async () => {
    const sim = await fx.OwnedCallerSimulator.create([owner]);

    await expect(sim.assertOnlyOwner(caller(owner))).resolves.toEqual([]);
    await expect(
      sim.assertOnlyOwner(caller(keyAccount(pad32('other')))),
    ).rejects.toThrow('Owned: caller is not the owner');
  });

  it('initializes in a plain constructor', async () => {
    const sim = await fx.OwnedCallerSimulator.create([owner]);

    expect(await sim.owner()).toEqual(owner);
  });

  it('needs no authenticator witness', () => {
    expect(() => new fx.MockOwnedCaller({})).not.toThrow();
    expect(
      () =>
        new fx.MockOwned(
          {} as unknown as ReturnType<typeof fx.pseudonymWitnesses>,
        ),
    ).toThrow('wit_PseudonymSK');
  });

  it('exports no ledger field with caller.ledger = false', async () => {
    const sim = await fx.OwnedCallerSimulator.create([owner]);

    expect(await sim.getPublicState()).toStrictEqual({});
  });
});

describe.skipIf(skipped)(title('MockClaimed'), () => {
  it('stores the caller the constructor authenticates', async () => {
    const alice = await fx.ClaimedSimulator.create([], {
      privateState: { secretKey: ALICE },
    });
    const bob = await fx.ClaimedSimulator.create([], {
      privateState: { secretKey: BOB },
    });

    expect((await alice.getPublicState()).Claimed__claimant).toEqual(
      pseudonym(ALICE, 'MockClaimed'),
    );
    expect((await bob.getPublicState()).Claimed__claimant).toEqual(
      pseudonym(BOB, 'MockClaimed'),
    );
  });
});

describe.skipIf(skipped)(title('MockClaimedFlag'), () => {
  const create = (isInit: boolean) =>
    fx.ClaimedFlagSimulator.create([isInit], {
      privateState: { secretKey: ALICE },
    });

  it('authenticates the caller under its own name when isInit is true', async () => {
    const sim = await create(true);

    expect((await sim.getPublicState()).Claimed__claimant).toEqual(
      pseudonym(ALICE, 'MockClaimedFlag'),
    );
  });

  it('stores no caller when isInit is false', async () => {
    const sim = await create(false);

    expect((await sim.getPublicState()).Claimed__claimant).toEqual({
      is_left: false,
      left: ZERO,
      right: { bytes: ZERO },
    });
  });
});

describe.skipIf(skipped)(title('MockShielded'), () => {
  const SALT = pad32('shielded instance salt');
  const BLINDING = pad32('blinding one');
  const OTHER_BLINDING = pad32('blinding two');

  const create = (secretKey = ALICE, blinding = BLINDING) =>
    fx.ShieldedSimulator.create([SALT], {
      privateState: { secretKey, blinding },
    });

  it('authenticates under the salt its ledger field holds', async () => {
    const sim = await create();

    await sim.join();

    const members = (await sim.getPublicState()).Shielded__members;
    expect(
      members.member(await sim.commitment(pseudonym(ALICE, SALT), BLINDING)),
    ).toBe(true);
    expect(
      members.member(
        await sim.commitment(pseudonym(ALICE, 'MockShielded'), BLINDING),
      ),
    ).toBe(false);
  });

  it('injects the blinding from the injector witness', async () => {
    const sim = await create();

    await sim.join();

    expect(await sim.isMember()).toBe(true);
    await sim.setPrivateState({ secretKey: ALICE, blinding: OTHER_BLINDING });
    expect(await sim.isMember()).toBe(false);
  });

  it('fails membership for another secret', async () => {
    const sim = await create();

    await sim.join();
    await sim.setPrivateState({ secretKey: BOB, blinding: BLINDING });

    expect(await sim.isMember()).toBe(false);
  });

  it('keeps the blinding parameter of a circuit without a caller', async () => {
    const sim = await create();
    const account = keyAccount(pad32('anyone'));

    expect(await sim.commitment(account, BLINDING)).not.toEqual(
      await sim.commitment(account, OTHER_BLINDING),
    );
  });

  it('exports only the listed ledger field', async () => {
    const sim = await create();

    expect(Object.keys(await sim.getPublicState())).toEqual([
      'Shielded__members',
    ]);
  });
});

describe.skipIf(skipped)(title('MockShieldedCaller'), () => {
  const SALT = pad32('shielded instance salt');
  const account = keyAccount(pad32('member'));

  it('takes the caller and the blinding as arguments', async () => {
    const sim = await fx.ShieldedCallerSimulator.create([SALT]);

    await sim.join(caller(account), pad32('blinding one'));

    expect(await sim.isMember(caller(account), pad32('blinding one'))).toBe(
      true,
    );
    expect(await sim.isMember(caller(account), pad32('blinding two'))).toBe(
      false,
    );
  });

  it('needs no authenticator or injector witness', () => {
    expect(() => new fx.MockShieldedCaller({})).not.toThrow();
    expect(
      () =>
        new fx.MockShielded(
          {} as unknown as ReturnType<typeof fx.shieldedWitnesses>,
        ),
    ).toThrow(/wit_PseudonymSK|wit_RandBlinding/);
  });
});

describe.skipIf(skipped)(title('MockPseudonym'), () => {
  it('returns the disclosed caller from authenticate', async () => {
    const sim = await fx.PseudonymSimulator.create([], {
      privateState: { secretKey: ALICE },
    });

    expect(await sim.authenticate(pad32('salt'))).toEqual({
      account: pseudonym(ALICE, 'salt'),
    });
  });

  it('derives the account the spec computes', async () => {
    const sim = await fx.PseudonymSimulator.create();

    expect(await sim.derive(BOB, pad32('MockOwned'))).toEqual(
      pseudonym(BOB, 'MockOwned'),
    );
  });
});

describe.skipIf(skipped)(title('MockClicker'), () => {
  it('implements the interface through re-exports and the fragment', async () => {
    const sim = await fx.ClickerSimulator.create();

    await sim.bump(5n);
    await sim.bump(7n);
    expect(await sim.total()).toBe(12n);

    await sim.reset();
    expect(await sim.total()).toBe(0n);
  });

  it('exports the ledger field under its plain name', async () => {
    const sim = await fx.ClickerSimulator.create();

    await sim.bump(3n);

    expect(await sim.getPublicState()).toStrictEqual({ _count: 3n });
  });
});

describe.skipIf(skipped)(title('MockHash'), () => {
  it('runs a renamed circuit under its new name', async () => {
    const sim = await fx.HashSimulator.create([0n]);

    expect(await sim.twice(21n)).toBe(42n);
  });

  it('runs a guarded circuit', async () => {
    const sim = await fx.HashSimulator.create([0n]);

    expect(await sim.square(5n)).toBe(25n);
  });

  it('runs a disclosed circuit under its name', async () => {
    const sim = await fx.HashSimulator.create([0n]);

    expect(await sim.mix(1n, 2n)).toBe(5n);
  });

  it('runs a re-exported pure circuit', async () => {
    const sim = await fx.HashSimulator.create([0n]);

    expect(await sim.digest(1n)).toEqual(persistentHash(CompactTypeField, 1n));
  });

  it('proves a guarded pure circuit and no re-exported, renamed or disclosed pure one', () => {
    expect(
      readdirSync(join(artifactDir('crypto', 'MockHash'), 'zkir')).sort(),
    ).toEqual(['seeded.zkir', 'square.zkir']);
  });

  it('runs the constructor and circuit of its fragment', async () => {
    const sim = await fx.HashSimulator.create([10n]);

    expect(await sim.seeded(2n)).toBe(32n);
    expect(await sim.getPublicState()).toStrictEqual({ _seed: 10n });
  });
});

describe.skipIf(skipped)(title('MockBag'), () => {
  it('passes the module argument to the module', async () => {
    const sim = await fx.BagSimulator.create([[0n, 0n]]);

    expect(await sim.capacity()).toBe(4n);
  });

  it('passes the circuit arguments to initialize in the constructor', async () => {
    const sim = await fx.BagSimulator.create([[3n, 4n]]);

    expect((await sim.getPublicState()).Bag__total).toBe(7n);
  });

  it('passes the circuit arguments to the wrappers', async () => {
    const sim = await fx.BagSimulator.create([[0n, 0n]]);

    await sim.put(5n);

    expect(await sim.first([7n, 8n, 9n])).toBe(7n);
    const state = await sim.getPublicState();
    expect(state.Bag__count).toBe(1n);
    expect(state.Bag__last).toEqual(persistentHash(CompactTypeField, 5n));
  });

  it('rejects a put past the module argument', async () => {
    const sim = await fx.BagSimulator.create([[0n, 0n]]);

    for (let i = 0n; i < 4n; i++) {
      await sim.put(i);
    }

    await expect(sim.put(4n)).rejects.toThrow('Bag: full');
  });
});

describe.skipIf(skipped)(title('MockBagNoInit'), () => {
  it('keeps initialize as a circuit with init = "none"', async () => {
    const sim = await fx.BagNoInitSimulator.create();
    const before = (await sim.getPublicState()).Bag__total;

    await sim.initialize([3n, 4n]);

    expect(before).toBe(0n);
    expect((await sim.getPublicState()).Bag__total).toBe(7n);
  });
});

describe.skipIf(skipped)(title('MockBagPair'), () => {
  it('passes each instance its own module argument', async () => {
    const sim = await fx.BagPairSimulator.create([[0n, 0n]]);

    expect(await sim.capacity2()).toBe(2n);
    expect(await sim.capacity3()).toBe(3n);
  });

  it('exports each instance pure circuit under its prefix', async () => {
    const sim = await fx.BagPairSimulator.create([[0n, 0n]]);

    expect(await sim.B2_capacity()).toBe(2n);
    expect(await sim.B3_capacity()).toBe(3n);
  });

  it('initializes every instance from one shared constructor parameter', async () => {
    const sim = await fx.BagPairSimulator.create([[3n, 4n]]);

    const state = await sim.getPublicState();
    expect(state.B2__total).toBe(7n);
    expect(state.B3__total).toBe(7n);
  });

  it('keeps the state of the two instances apart', async () => {
    const sim = await fx.BagPairSimulator.create([[0n, 0n]]);

    await sim.put2(1n);
    await sim.put2(2n);
    await expect(sim.put2(3n)).rejects.toThrow('Bag: full');
    await sim.put3(4n);

    const state = await sim.getPublicState();
    expect(state.B2__count).toBe(2n);
    expect(state.B3__count).toBe(1n);
    expect(state.B3__last).toEqual(persistentHash(CompactTypeField, 4n));
  });
});

describe.skipIf(skipped)(title('MockScale'), () => {
  it('keeps the name of the first overload and numbers the next one', async () => {
    const sim = await fx.ScaleSimulator.create();

    expect(await sim.scale(21n)).toBe(42n);
    expect(await sim.scale2(6n, 7n)).toBe(42n);
  });

  it('renames one overload by its signature', async () => {
    const sim = await fx.ScaleSimulator.create();

    expect(await sim.mix(1n)).toBe(2n);
    expect(await sim.mixPair(1n, 2n)).toBe(4n);
  });
});
