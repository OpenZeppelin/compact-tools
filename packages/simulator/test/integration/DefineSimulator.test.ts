import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ContractArtifact,
  clearLiveBackend,
  composePrivateState,
  composeWitnesses,
  defineSimulator,
  type LiveBackendRequest,
  registerLiveBackend,
} from '../../src/index.js';
import * as DefineArtifact from '../fixtures/artifacts/Define/contract/index.js';
import * as FlatArtifact from '../fixtures/artifacts/Flat/contract/index.js';
import {
  CountPrivateState,
  CountWitnesses,
  DefineWitnesses,
  SecretPrivateState,
  SecretWitnesses,
} from '../fixtures/sample-contracts/witnesses/DefineWitnesses.js';
import {
  FlatPrivateState,
  FlatWitnesses,
} from '../fixtures/sample-contracts/witnesses/FlatWitnesses.js';

const OWNER = new Uint8Array(32).fill(1);
const VALUES = [4n, 5n];
const ORIGIN = { x: 1n, y: 2n };

/** Module and authenticator parts, merged by the definition. */
class DefineSimulator extends defineSimulator(DefineArtifact, {
  witnesses: [CountWitnesses, SecretWitnesses],
  privateState: [CountPrivateState.generate, SecretPrivateState.generate],
  artifactName: 'Define',
}) {}

/** The single-factory form. */
class BundledSimulator extends defineSimulator(DefineArtifact, {
  witnesses: () => DefineWitnesses(),
  privateState: () => ({ count: 30n, secret: 70n }),
}) {}

class FlatSimulator extends defineSimulator(FlatArtifact, {
  witnesses: FlatWitnesses,
  privateState: FlatPrivateState.generate,
}) {}

describe('defineSimulator', () => {
  describe('create', () => {
    it('takes the constructor arguments positionally', async () => {
      const sim = await DefineSimulator.create(OWNER, VALUES, ORIGIN);
      const ledger = await sim.getPublicState();

      expect(ledger._owner).toEqual(OWNER);
      expect(ledger._values).toEqual(VALUES);
      expect(ledger._origin).toEqual(ORIGIN);
    });

    it('reads one argument past the arity as the options, even after a struct', async () => {
      const sim = await DefineSimulator.create(OWNER, VALUES, ORIGIN, {
        privateState: { count: 11n, secret: 12n },
      });

      expect(await sim.storeCount()).toBe(11n);
      expect((await sim.getPublicState())._origin).toEqual(ORIGIN);
    });

    it('takes the options alone for a contract without constructor arguments', async () => {
      const sim = await FlatSimulator.create({ privateState: { value: 9n } });

      await sim.setFromWitness();
      expect((await sim.getPublicState())._last).toBe(9n);
    });

    it('rejects any other argument count', async () => {
      // @ts-expect-error one constructor argument missing.
      await expect(DefineSimulator.create(OWNER, VALUES)).rejects.toThrow(
        'create: expected 3 constructor argument(s) and an optional options object, received 2 argument(s)',
      );
      await expect(
        // @ts-expect-error one argument past the options.
        DefineSimulator.create(OWNER, VALUES, ORIGIN, {}, {}),
      ).rejects.toThrow('received 5 argument(s)');
    });

    it('resolves to an instance of the calling class', async () => {
      const sim = await DefineSimulator.create(OWNER, VALUES, ORIGIN);

      expect(sim).toBeInstanceOf(DefineSimulator);
      expect(DefineSimulator.name).toBe('DefineSimulator');
    });

    it('keeps the tuple form', async () => {
      const sim = await DefineSimulator._create([OWNER, VALUES, ORIGIN]);

      expect((await sim.getPublicState())._owner).toEqual(OWNER);
    });
  });

  describe('arity', () => {
    // An artifact whose `initialState` does not check its argument count.
    const stub = {
      Contract: class {
        circuits = {};
        impureCircuits = {};
        async initialState(): Promise<never> {
          throw new Error('unused');
        }
      },
      ledger: () => ({}),
    } as unknown as ContractArtifact;

    it('throws at definition when the compiled contract does not state it', () => {
      expect(() => defineSimulator(stub)).toThrow(
        'defineSimulator: cannot read the constructor arity from the compiled contract; pass `arity`',
      );
    });

    it('takes an explicit arity instead', () => {
      expect(() => defineSimulator(stub, { arity: 2 })).not.toThrow();
    });

    it('splits the arguments at an explicit arity', async () => {
      const TwoArgs = defineSimulator(DefineArtifact, {
        witnesses: () => DefineWitnesses(),
        arity: 2,
      });

      // The third argument is read as the options, so the contract gets two.
      await expect(TwoArgs.create(OWNER, VALUES, ORIGIN)).rejects.toThrow(
        'expected 4 arguments',
      );
    });
  });

  describe('circuits', () => {
    it('installs one async method per circuit', async () => {
      const sim = await DefineSimulator.create(OWNER, VALUES, ORIGIN);

      expect(await sim.storeSecret()).toBe(7n);
      expect(await sim.double(4n)).toBe(8n);
    });

    it('installs each pure circuit as a synchronous static method', () => {
      expect(DefineSimulator.double(21n)).toBe(42n);
    });

    it('skips static names the class already has', async () => {
      const sim = await DefineSimulator.create(OWNER, VALUES, ORIGIN);

      expect(DefineSimulator.name).toBe('DefineSimulator');
      expect(Object.hasOwn(DefineSimulator, 'create')).toBe(false);
      expect(await sim.circuits.pure.name()).toBe(1n);
      expect(await sim.circuits.pure.create()).toBe(2n);
    });
  });

  describe('witnesses and private state from parts', () => {
    it('merges the parts', async () => {
      const sim = await DefineSimulator.create(OWNER, VALUES, ORIGIN);

      expect(await sim.getPrivateState()).toEqual({ count: 3n, secret: 7n });
      expect(Object.keys(sim.witnesses).sort()).toEqual([
        'wit_count',
        'wit_secret',
      ]);
      expect(await sim.storeCount()).toBe(3n);
      expect(await sim.storeSecret()).toBe(7n);
    });

    it('gives each witness the whole private state', async () => {
      const sim = await DefineSimulator.create(OWNER, VALUES, ORIGIN);

      await sim.updatePrivateState({ secret: 8n });
      expect(await sim.storeSecret()).toBe(8n);
      expect(await sim.getPrivateState()).toEqual({ count: 3n, secret: 8n });
    });

    it('keeps the single-factory form', async () => {
      const sim = await BundledSimulator.create(OWNER, VALUES, ORIGIN);

      expect(await sim.storeCount()).toBe(30n);
      expect(await sim.storeSecret()).toBe(70n);
    });

    it('rejects a witness two parts define', async () => {
      const Clash = defineSimulator(DefineArtifact, {
        witnesses: [DefineWitnesses, SecretWitnesses],
      });

      await expect(Clash.create(OWNER, VALUES, ORIGIN)).rejects.toThrow(
        'witness "wit_secret" is defined by both "DefineWitnesses" and "SecretWitnesses"',
      );
    });

    it('rejects a private-state key two parts define', async () => {
      const Clash = defineSimulator(DefineArtifact, {
        witnesses: () => DefineWitnesses(),
        privateState: [
          SecretPrivateState.generate,
          () => ({ secret: 1n, count: 0n }),
        ],
      });

      await expect(Clash.create(OWNER, VALUES, ORIGIN)).rejects.toThrow(
        'private state key "secret" is defined by both "generate" and part 1',
      );
    });
  });

  describe('extend', () => {
    const Extended = defineSimulator(DefineArtifact, {
      witnesses: () => DefineWitnesses(),
      privateState: () => ({ count: 3n, secret: 7n }),
      extend: (sim) => ({
        privateState: {
          injectSecret: (secret: bigint) => sim.updatePrivateState({ secret }),
        },
        double: (x: bigint): bigint => DefineArtifact.pureCircuits.double(x),
      }),
    });

    it('adds the members to every instance', async () => {
      const sim = await Extended.create(OWNER, VALUES, ORIGIN);

      await sim.privateState.injectSecret(9n);
      expect(await sim.storeSecret()).toBe(9n);
      expect(Object.keys(sim)).toContain('privateState');
    });

    it('replaces a circuit method of the same name', async () => {
      const sim = await Extended.create(OWNER, VALUES, ORIGIN);

      expect(sim.double(5n)).toBe(10n);
      expect(await sim.circuits.pure.double(5n)).toBe(10n);
    });
  });

  describe('prepare', () => {
    type Wallet = { secret: bigint };

    // A witness that reads a wallet the test holds, not the private state.
    const walletWitnesses = (wallet: Wallet) => ({
      ...CountWitnesses(),
      wit_secret: ({
        privateState,
      }: WitnessContext<unknown, CountPrivateState>): [
        CountPrivateState,
        bigint,
      ] => [privateState, wallet.secret],
    });

    const Prepared = defineSimulator(DefineArtifact, {
      witnesses: () => walletWitnesses({ secret: 0n }),
      privateState: CountPrivateState.generate,
      prepare: (wallet: Wallet = { secret: 5n }) => ({
        args: [OWNER, VALUES, ORIGIN] as const,
        options: { witnesses: walletWitnesses(wallet) },
        fields: { wallet },
      }),
    });

    it('maps the arguments to the constructor arguments, options and fields', async () => {
      const wallet = { secret: 6n };
      const sim = await Prepared.create(wallet);

      expect(sim.wallet).toBe(wallet);
      expect((await sim.getPublicState())._owner).toEqual(OWNER);
      expect(await sim.storeSecret()).toBe(6n);
      wallet.secret = 13n;
      expect(await sim.storeSecret()).toBe(13n);
    });

    it('takes its own defaults', async () => {
      const sim = await Prepared.create();

      expect(await sim.storeSecret()).toBe(5n);
    });
  });

  describe('live backend', () => {
    afterEach(() => clearLiveBackend());

    it('hands the registered backend a full simulator config', async () => {
      const captured: { request?: LiveBackendRequest } = {};
      registerLiveBackend(async (req) => {
        captured.request = req;
        throw new Error('captured');
      });

      await expect(
        DefineSimulator.create(OWNER, VALUES, ORIGIN, { backend: 'live' }),
      ).rejects.toThrow('captured');
      const { request } = captured;
      const config = request?.config;

      expect(config?.artifactName).toBe('Define');
      expect(request?.contractArgs).toEqual([OWNER, VALUES, ORIGIN]);
      expect(config?.contractArgs(...(request?.contractArgs ?? []))).toEqual([
        OWNER,
        VALUES,
        ORIGIN,
      ]);
      expect(Object.keys(config?.witnessesFactory() ?? {}).sort()).toEqual([
        'wit_count',
        'wit_secret',
      ]);
      expect(config?.defaultPrivateState()).toEqual({ count: 3n, secret: 7n });
    });
  });
});

describe('composeWitnesses and composePrivateState', () => {
  it('merge factories for createSimulator', () => {
    const witnesses = composeWitnesses(CountWitnesses, SecretWitnesses)();
    const privateState = composePrivateState(
      CountPrivateState.generate,
      SecretPrivateState.generate,
    )();

    expect(Object.keys(witnesses).sort()).toEqual(['wit_count', 'wit_secret']);
    expect(privateState).toEqual({ count: 3n, secret: 7n });
  });

  it('names an anonymous part by its position', () => {
    const merged = composeWitnesses(
      () => ({ wit_a: () => 1 }),
      () => ({ wit_a: () => 2 }),
    );

    expect(merged).toThrow(
      'witness "wit_a" is defined by both part 0 and part 1',
    );
  });
});
