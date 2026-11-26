import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CompactTypeBytes,
  CompactTypeField,
  CompactTypeVector,
  persistentHash,
  type WitnessContext,
} from '@midnight-ntwrk/compact-runtime';
import { createSimulator } from '@openzeppelin/compact-simulator';
import { describe, expect, it } from 'vitest';
import { packageDir } from '../src/launcher.ts';
import { binaryUnderTest } from './binaryUnderTest.ts';
import {
  ledger as bagLedger,
  Contract as MockBag,
} from './fixtures/artifacts/MockBag/contract/index.js';
import {
  ledger as bagNoInitLedger,
  Contract as MockBagNoInit,
} from './fixtures/artifacts/MockBagNoInit/contract/index.js';
import {
  ledger as hashLedger,
  Contract as MockHash,
} from './fixtures/artifacts/MockHash/contract/index.js';
import {
  type ContractAddress,
  type Either,
  Contract as MockOwned,
  ledger as ownedLedger,
} from './fixtures/artifacts/MockOwned/contract/index.js';
import {
  type Caller,
  Contract as MockOwnedCaller,
  ledger as ownedCallerLedger,
} from './fixtures/artifacts/MockOwnedCaller/contract/index.js';
import {
  Contract as MockPseudonym,
  ledger as pseudonymLedger,
} from './fixtures/artifacts/MockPseudonym/contract/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CONFIG = join(FIXTURES, 'compact-mock.toml');
const ARTIFACTS = join(FIXTURES, 'artifacts');
const BIN = join(packageDir, 'src', 'compactMock.ts');

const { binary, skip } = binaryUnderTest(process.env, existsSync);
const skipReason = skip === undefined ? '' : ` (skipped: ${skip})`;

type Account = Either<Uint8Array, ContractAddress>;
type SecretState = { secretKey: Uint8Array };
type NoState = Record<string, never>;

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

/** `Pseudonym.derive(secretKey, pad(32, salt))`, computed without the contract. */
function pseudonym(secretKey: Uint8Array, salt: string): Account {
  return keyAccount(
    persistentHash(new CompactTypeVector(2, new CompactTypeBytes(32)), [
      secretKey,
      pad32(salt),
    ]),
  );
}

const ALICE = pad32('alice secret key');
const BOB = pad32('bob secret key');

const pseudonymWitnesses = () => ({
  wit_PseudonymSK({
    privateState,
  }: WitnessContext<unknown, SecretState>): [SecretState, Uint8Array] {
    return [privateState, privateState.secretKey];
  },
});
type PseudonymWitnesses = ReturnType<typeof pseudonymWitnesses>;

const OwnedSimulator = createSimulator({
  contractFactory: (witnesses: PseudonymWitnesses) =>
    new MockOwned<SecretState>(witnesses),
  defaultPrivateState: (): SecretState => ({ secretKey: ALICE }),
  contractArgs: (initialOwner: Account, isInit: boolean) => [
    initialOwner,
    isInit,
  ],
  ledgerExtractor: (state) => ownedLedger(state),
  witnessesFactory: () => pseudonymWitnesses(),
  flatCircuits: true,
});

const OwnedCallerSimulator = createSimulator({
  contractFactory: (witnesses: NoState) =>
    new MockOwnedCaller<NoState>(witnesses),
  defaultPrivateState: (): NoState => ({}),
  contractArgs: (initialOwner: Account) => [initialOwner],
  ledgerExtractor: (state) => ownedCallerLedger(state),
  witnessesFactory: (): NoState => ({}),
  flatCircuits: true,
});

const PseudonymSimulator = createSimulator({
  contractFactory: (witnesses: PseudonymWitnesses) =>
    new MockPseudonym<SecretState>(witnesses),
  defaultPrivateState: (): SecretState => ({ secretKey: ALICE }),
  contractArgs: () => [],
  ledgerExtractor: (state) => pseudonymLedger(state),
  witnessesFactory: () => pseudonymWitnesses(),
  flatCircuits: true,
});

const HashSimulator = createSimulator({
  contractFactory: (witnesses: NoState) => new MockHash<NoState>(witnesses),
  defaultPrivateState: (): NoState => ({}),
  contractArgs: (seed: bigint) => [seed],
  ledgerExtractor: (state) => hashLedger(state),
  witnessesFactory: (): NoState => ({}),
  flatCircuits: true,
});

const BagSimulator = createSimulator({
  contractFactory: (witnesses: NoState) => new MockBag<NoState>(witnesses),
  defaultPrivateState: (): NoState => ({}),
  contractArgs: (seed: bigint[]) => [seed],
  ledgerExtractor: (state) => bagLedger(state),
  witnessesFactory: (): NoState => ({}),
  flatCircuits: true,
});

const BagNoInitSimulator = createSimulator({
  contractFactory: (witnesses: NoState) =>
    new MockBagNoInit<NoState>(witnesses),
  defaultPrivateState: (): NoState => ({}),
  contractArgs: () => [],
  ledgerExtractor: (state) => bagNoInitLedger(state),
  witnessesFactory: (): NoState => ({}),
  flatCircuits: true,
});

const circuitNames = (contract: { circuits: object }): string[] =>
  Object.keys(contract.circuits).sort();

describe('the committed fixture mocks', () => {
  it.skipIf(skip !== undefined)(
    `match what compact-mock generates from the fixture config${skipReason}`,
    () => {
      const run = spawnSync(
        binary,
        ['generate', '--check', '--config', CONFIG],
        { encoding: 'utf8' },
      );

      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('6 mocks up to date');
      expect(run.status).toBe(0);
    },
  );

  it.skipIf(skip !== undefined)(
    `match through the compact-mock bin${skipReason}`,
    () => {
      const run = spawnSync(
        process.execPath,
        [BIN, 'generate', '--check', '--config', CONFIG],
        {
          encoding: 'utf8',
          env: { ...process.env, COMPACT_MOCK_BINARY: binary },
        },
      );

      expect(run.stdout).toBe('');
      expect(run.status).toBe(0);
    },
  );

  it('expose exactly the configured circuits', () => {
    const witnesses = pseudonymWitnesses();

    expect(circuitNames(new MockOwned(witnesses))).toEqual([
      'assertOnlyOwner',
      'owner',
      'setPair',
      'transferOwnership',
    ]);
    expect(circuitNames(new MockOwnedCaller({}))).toEqual([
      'assertOnlyOwner',
      'owner',
      'setPair',
      'transferOwnership',
    ]);
    expect(circuitNames(new MockPseudonym(witnesses))).toEqual([
      'authenticate',
      'derive',
    ]);
    expect(circuitNames(new MockHash({}))).toEqual([
      'digest',
      'mix',
      'seeded',
      'square',
      'twice',
    ]);
    expect(circuitNames(new MockBag({}))).toEqual(['capacity', 'first', 'put']);
    expect(circuitNames(new MockBagNoInit({}))).toEqual([
      'capacity',
      'first',
      'initialize',
      'put',
    ]);
  });
});

describe('MockOwned', () => {
  const create = (owner: Account, isInit: boolean, secretKey = ALICE) =>
    OwnedSimulator.create([owner, isInit], { privateState: { secretKey } });

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

  it('exports the module ledger fields', async () => {
    const sim = await create(pseudonym(ALICE, 'MockOwned'), true);

    expect(Object.keys(await sim.getPublicState()).sort()).toEqual([
      'Owned__initialized',
      'Owned__owner',
      'Owned__tag',
      'Owned__value',
    ]);
  });
});

describe('MockOwnedCaller', () => {
  const owner = keyAccount(pad32('owner'));
  const caller = (account: Account): Caller => ({ account });

  it('takes the caller as an argument', async () => {
    const sim = await OwnedCallerSimulator.create([owner]);

    await expect(sim.assertOnlyOwner(caller(owner))).resolves.toEqual([]);
    await expect(
      sim.assertOnlyOwner(caller(keyAccount(pad32('other')))),
    ).rejects.toThrow('Owned: caller is not the owner');
  });

  it('initializes in a plain constructor', async () => {
    const sim = await OwnedCallerSimulator.create([owner]);

    expect(await sim.owner()).toEqual(owner);
  });

  it('needs no authenticator witness', () => {
    expect(() => new MockOwnedCaller({})).not.toThrow();
    expect(() => new MockOwned({} as PseudonymWitnesses)).toThrow(
      'wit_PseudonymSK',
    );
  });

  it('exports no ledger field with ledger = false', async () => {
    const sim = await OwnedCallerSimulator.create([owner]);

    expect(await sim.getPublicState()).toStrictEqual({});
  });
});

describe('MockPseudonym', () => {
  it('returns the disclosed caller from authenticate', async () => {
    const sim = await PseudonymSimulator.create();

    expect(await sim.authenticate(pad32('salt'))).toEqual({
      account: pseudonym(ALICE, 'salt'),
    });
  });

  it('derives the account the spec computes', async () => {
    const sim = await PseudonymSimulator.create();

    expect(await sim.derive(BOB, pad32('MockOwned'))).toEqual(
      pseudonym(BOB, 'MockOwned'),
    );
  });
});

describe('MockHash', () => {
  it('runs a renamed circuit under its new name', async () => {
    const sim = await HashSimulator.create([0n]);

    expect(await sim.twice(21n)).toBe(42n);
  });

  it('runs a guarded circuit', async () => {
    const sim = await HashSimulator.create([0n]);

    expect(await sim.square(5n)).toBe(25n);
  });

  it('runs a disclosed circuit under its name', async () => {
    const sim = await HashSimulator.create([0n]);

    expect(await sim.mix(1n, 2n)).toBe(5n);
  });

  it('runs a re-exported pure circuit', async () => {
    const sim = await HashSimulator.create([0n]);

    expect(await sim.digest(1n)).toEqual(persistentHash(CompactTypeField, 1n));
  });

  it('proves a guarded pure circuit and no re-exported, renamed or disclosed pure one', () => {
    expect(readdirSync(join(ARTIFACTS, 'MockHash', 'zkir')).sort()).toEqual([
      'seeded.zkir',
      'square.zkir',
    ]);
  });

  it('runs the constructor and circuit of its fragment', async () => {
    const sim = await HashSimulator.create([10n]);

    expect(await sim.seeded(2n)).toBe(32n);
    expect(await sim.getPublicState()).toStrictEqual({ _seed: 10n });
  });
});

describe('MockBag', () => {
  it('passes the module argument to the module', async () => {
    const sim = await BagSimulator.create([[0n, 0n]]);

    expect(await sim.capacity()).toBe(4n);
  });

  it('passes the circuit arguments to initialize in the constructor', async () => {
    const sim = await BagSimulator.create([[3n, 4n]]);

    expect((await sim.getPublicState()).Bag__total).toBe(7n);
  });

  it('passes the circuit arguments to the wrappers', async () => {
    const sim = await BagSimulator.create([[0n, 0n]]);

    await sim.put(5n);

    expect(await sim.first([7n, 8n, 9n])).toBe(7n);
    const state = await sim.getPublicState();
    expect(state.Bag__count).toBe(1n);
    expect(state.Bag__last).toEqual(persistentHash(CompactTypeField, 5n));
  });

  it('rejects a put past the module argument', async () => {
    const sim = await BagSimulator.create([[0n, 0n]]);

    for (let i = 0n; i < 4n; i++) {
      await sim.put(i);
    }

    await expect(sim.put(4n)).rejects.toThrow('Bag: full');
  });
});

describe('MockBagNoInit', () => {
  it('keeps initialize as a circuit with init = "none"', async () => {
    const sim = await BagNoInitSimulator.create();
    const before = (await sim.getPublicState()).Bag__total;

    await sim.initialize([3n, 4n]);

    expect(before).toBe(0n);
    expect((await sim.getPublicState()).Bag__total).toBe(7n);
  });
});
