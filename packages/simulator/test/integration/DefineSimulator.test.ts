import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { SIMULATOR_FIELDS } from '../../src/factory/createSimulator.js';
import {
  type ContractArtifact,
  clearLiveBackend,
  composePrivateState,
  composeWitnesses,
  createSimulator,
  defineSimulator,
  type LiveBackendRequest,
  registerLiveBackend,
} from '../../src/index.js';
import * as DefineArtifact from '../fixtures/artifacts/Define/contract/index.js';
import * as FlatArtifact from '../fixtures/artifacts/Flat/contract/index.js';
import {
  CountingWitnesses,
  CountPrivateState,
  CountWitnesses,
  DefinePrivateState,
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

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** Declared, so the array's type keeps both parts instead of the wider one. */
type ClashingParts = (typeof DefineWitnesses | typeof SecretWitnesses)[];

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

    it('takes undefined in the options slot', async () => {
      const sim = await DefineSimulator.create(
        OWNER,
        VALUES,
        ORIGIN,
        undefined,
      );

      expect(await sim.storeSecret()).toBe(7n);
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

    it('rejects a value in the options slot that is not an options object', async () => {
      await expect(
        // @ts-expect-error a bigint is not options.
        DefineSimulator.create(OWNER, VALUES, ORIGIN, 5n),
      ).rejects.toThrow(
        'create: argument 4 must be an options object, received BigInt',
      );
      await expect(
        // @ts-expect-error a byte array is not options.
        DefineSimulator.create(OWNER, VALUES, ORIGIN, OWNER),
      ).rejects.toThrow(
        'argument 4 must be an options object, received Uint8Array',
      );
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
        privateState: DefinePrivateState.generate,
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

    it('gives a pure circuit named then no static, so the class is not thenable', async () => {
      const sim = await DefineSimulator.create(OWNER, VALUES, ORIGIN);

      expect(Object.hasOwn(DefineSimulator, 'then')).toBe(false);
      await expect(Promise.resolve(DefineSimulator)).resolves.toBe(
        DefineSimulator,
      );
      expect(await sim.circuits.pure.then()).toBe(3n);
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

    it('writes the part a witness returns over the whole private state', async () => {
      const Counting = defineSimulator(DefineArtifact, {
        witnesses: [CountingWitnesses, SecretWitnesses],
        privateState: [CountPrivateState.generate, SecretPrivateState.generate],
      });
      const sim = await Counting.create(OWNER, VALUES, ORIGIN);

      expect(await sim.storeCount()).toBe(3n);
      expect(await sim.getPrivateState()).toEqual({ count: 4n, secret: 7n });
      expect(await sim.storeSecret()).toBe(7n);
    });

    it('keeps the prototype members of a part, called on the part', async () => {
      class SecretWitnessSet {
        readonly offset = 100n;

        wit_secret({
          privateState,
        }: WitnessContext<unknown, SecretPrivateState>): [
          SecretPrivateState,
          bigint,
        ] {
          return [privateState, privateState.secret + this.offset];
        }
      }
      const Prototype = defineSimulator(DefineArtifact, {
        witnesses: [CountWitnesses, () => new SecretWitnessSet()],
        privateState: [CountPrivateState.generate, SecretPrivateState.generate],
      });
      const sim = await Prototype.create(OWNER, VALUES, ORIGIN);

      expect(await sim.storeSecret()).toBe(107n);
    });

    it('keeps the single-factory form', async () => {
      const sim = await BundledSimulator.create(OWNER, VALUES, ORIGIN);

      expect(await sim.storeCount()).toBe(30n);
      expect(await sim.storeSecret()).toBe(70n);
    });

    it('rejects a witness two parts define, at definition', () => {
      expect(() =>
        defineSimulator(DefineArtifact, {
          witnesses: [DefineWitnesses, SecretWitnesses] as ClashingParts,
          privateState: DefinePrivateState.generate,
        }),
      ).toThrow(
        'witness "wit_secret" is defined by both part 0 ("DefineWitnesses") and part 1 ("SecretWitnesses")',
      );
    });

    it('rejects a clash also when prepare supplies the witnesses and private state', () => {
      expect(() =>
        defineSimulator(DefineArtifact, {
          witnesses: [DefineWitnesses, SecretWitnesses] as ClashingParts,
          privateState: DefinePrivateState.generate,
          prepare: () => ({
            args: [OWNER, VALUES, ORIGIN] as const,
            options: {
              witnesses: DefineWitnesses(),
              privateState: DefinePrivateState.generate(),
            },
          }),
        }),
      ).toThrow('witness "wit_secret" is defined by both');
    });

    it('names two parts with the same function name by position', () => {
      const Other = { generate: (): SecretPrivateState => ({ secret: 1n }) };

      expect(() =>
        defineSimulator(DefineArtifact, {
          witnesses: () => DefineWitnesses(),
          privateState: [
            CountPrivateState.generate,
            SecretPrivateState.generate,
            Other.generate,
          ],
        }),
      ).toThrow(
        'private state key "secret" is defined by both part 1 ("generate") and part 2 ("generate")',
      );
    });
  });

  describe('witness typing', () => {
    it('checks the witnesses against the compiled contract at compile time only', () => {
      // Each definition below fails `tsc`; at runtime it only builds a class.
      expect(() => [
        defineSimulator(DefineArtifact, {
          // @ts-expect-error `wit_secret` is missing.
          witnesses: CountWitnesses,
          privateState: CountPrivateState.generate,
        }),
        defineSimulator(DefineArtifact, {
          // @ts-expect-error the witnesses read keys the private state lacks.
          witnesses: () => DefineWitnesses(),
          privateState: CountPrivateState.generate,
        }),
        defineSimulator(DefineArtifact, {
          // @ts-expect-error the authenticator part is missing.
          witnesses: [CountWitnesses],
          privateState: [CountPrivateState.generate],
        }),
        // @ts-expect-error a contract with witnesses needs `witnesses`.
        defineSimulator(DefineArtifact, {
          privateState: DefinePrivateState.generate,
        }),
      ]).not.toThrow();
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

    it('keeps a getter a getter', async () => {
      let reads = 0;
      const Getter = defineSimulator(DefineArtifact, {
        witnesses: () => DefineWitnesses(),
        privateState: DefinePrivateState.generate,
        extend: () => ({
          get reads(): number {
            reads += 1;
            return reads;
          },
        }),
      });
      const sim = await Getter.create(OWNER, VALUES, ORIGIN);

      expect([sim.reads, sim.reads]).toEqual([1, 2]);
    });

    it.each([
      'getPrivateState',
      'circuits',
      '_backend',
      'signers',
      'then',
      'toString',
    ])('rejects a member named %s', async (name) => {
      const Shadow = defineSimulator(DefineArtifact, {
        witnesses: () => DefineWitnesses(),
        privateState: DefinePrivateState.generate,
        extend: () => ({ [name]: () => 'shadowed' }),
      });

      await expect(Shadow.create(OWNER, VALUES, ORIGIN)).rejects.toThrow(
        `defineSimulator: extend cannot define "${name}", a simulator member name`,
      );
    });

    it('lists the own fields every instance has', async () => {
      const sim = await DefineSimulator.create(OWNER, VALUES, ORIGIN);

      expect(Object.keys(sim).sort()).toEqual([...SIMULATOR_FIELDS].sort());
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

    it('has no tuple form', async () => {
      // @ts-expect-error a class with `prepare` has no `_create`.
      await expect(Prepared._create([OWNER, VALUES, ORIGIN])).rejects.toThrow(
        'defineSimulator: a simulator defined with `prepare` has no `_create`; call `create`',
      );
    });

    it('keeps a fields getter a getter', async () => {
      let reads = 0;
      const Getter = defineSimulator(DefineArtifact, {
        witnesses: () => DefineWitnesses(),
        privateState: DefinePrivateState.generate,
        prepare: () => ({
          args: [OWNER, VALUES, ORIGIN] as const,
          fields: {
            get reads(): number {
              reads += 1;
              return reads;
            },
          },
        }),
      });
      const sim = await Getter.create();

      expect([sim.reads, sim.reads]).toEqual([1, 2]);
    });

    it.each(['signers', 'witnesses', 'circuits', 'then'])(
      'rejects a field named %s',
      async (name) => {
        const Shadow = defineSimulator(DefineArtifact, {
          witnesses: () => DefineWitnesses(),
          privateState: DefinePrivateState.generate,
          prepare: () => ({
            args: [OWNER, VALUES, ORIGIN] as const,
            fields: { [name]: 1 },
          }),
        });

        await expect(Shadow.create()).rejects.toThrow(
          `defineSimulator: prepare \`fields\` cannot define "${name}", a simulator member name`,
        );
      },
    );

    it('rejects a field named like an extend member', async () => {
      const Clash = defineSimulator(DefineArtifact, {
        witnesses: () => DefineWitnesses(),
        privateState: DefinePrivateState.generate,
        extend: () => ({ wallet: () => 'extended' }),
        prepare: () => ({
          args: [OWNER, VALUES, ORIGIN] as const,
          fields: { wallet: 1 },
        }),
      });

      await expect(Clash.create()).rejects.toThrow(
        'defineSimulator: "wallet" is defined by both `extend` and prepare `fields`',
      );
    });
  });

  describe('caller', () => {
    const recorded = async (sim: {
      getPublicState(): Promise<{ _caller: { bytes: Uint8Array } }>;
    }): Promise<string> => hex((await sim.getPublicState())._caller.bytes);

    const Pure = defineSimulator(FlatArtifact, {
      witnesses: FlatWitnesses,
      privateState: FlatPrivateState.generate,
      extend: () => ({ add: FlatArtifact.pureCircuits.add }),
    });

    it('lets a synchronous extend member consume the as() caller', async () => {
      const sim = await Pure.create();
      await sim.recordCaller();
      const defaultCaller = await recorded(sim);

      expect(sim.as('ALICE').add(1n, 2n)).toBe(3n);
      await sim.recordCaller();

      expect(await recorded(sim)).toBe(defaultCaller);
    });

    it('keeps the as() caller through an extend helper in argument position', async () => {
      const Helper = defineSimulator(FlatArtifact, {
        witnesses: FlatWitnesses,
        privateState: FlatPrivateState.generate,
        extend: () => ({ noArgs: (): [] => [] }),
      });
      const sim = await Helper.create();

      // `noArgs` runs after `as()` and before the circuit.
      await sim.as('ALICE').recordCaller(...sim.noArgs());

      expect(await recorded(sim)).toBe(sim.signers.resolveDryKey('ALICE'));
    });

    it('applies the as() caller to the first circuit an extend helper calls', async () => {
      const Twice = defineSimulator(FlatArtifact, {
        witnesses: FlatWitnesses,
        privateState: FlatPrivateState.generate,
        extend: (sim) => ({
          recordTwice: async (): Promise<string[]> => {
            await sim.recordCaller();
            const first = await recorded(sim);
            await sim.recordCaller();
            return [first, await recorded(sim)];
          },
        }),
      });
      const sim = await Twice.create();
      await sim.recordCaller();
      const defaultCaller = await recorded(sim);

      expect(await sim.as('ALICE').recordTwice()).toEqual([
        sim.signers.resolveDryKey('ALICE'),
        defaultCaller,
      ]);
    });

    it('keeps an as() caller set while an async circuit replacement is pending', async () => {
      const Replaced = defineSimulator(FlatArtifact, {
        witnesses: FlatWitnesses,
        privateState: FlatPrivateState.generate,
        extend: () => ({
          bump: async (): Promise<[]> => {
            await Promise.resolve();
            return [];
          },
        }),
      });
      const sim = await Replaced.create();

      const pending = sim.bump();
      sim.as('BOB');
      await pending;
      await sim.recordCaller();

      expect(await recorded(sim)).toBe(sim.signers.resolveDryKey('BOB'));
    });

    describe('an async circuit replacement that awaits before its circuit', () => {
      const Guarded = defineSimulator(FlatArtifact, {
        witnesses: FlatWitnesses,
        privateState: FlatPrivateState.generate,
        extend: (sim) => ({
          recordCaller: async (): Promise<[]> => {
            await sim.getPublicState();
            return sim.circuits.impure.recordCaller();
          },
          bump: async (): Promise<[]> => {
            await sim.getPublicState();
            await sim.circuits.impure.bump();
            return sim.circuits.impure.recordCaller();
          },
        }),
      });

      it('runs its circuit as the as() caller', async () => {
        const sim = await Guarded.create();

        await sim.as('ALICE').recordCaller();

        expect(await recorded(sim)).toBe(sim.signers.resolveDryKey('ALICE'));
      });

      it('runs only its first circuit as the as() caller', async () => {
        const sim = await Guarded.create();
        await sim.recordCaller();
        const defaultCaller = await recorded(sim);

        await sim.as('ALICE').bump();

        expect(await recorded(sim)).toBe(defaultCaller);
      });

      it('takes the as() caller when it starts, so an overlapping call runs as the default caller', async () => {
        let open = (): void => {};
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        const Gated = defineSimulator(FlatArtifact, {
          witnesses: FlatWitnesses,
          privateState: FlatPrivateState.generate,
          extend: (sim) => ({
            recordCaller: async (): Promise<[]> => {
              await gate;
              return sim.circuits.impure.recordCaller();
            },
          }),
        });
        const sim = await Gated.create();
        await sim.circuits.impure.recordCaller();
        const defaultCaller = await recorded(sim);

        const first = sim.as('ALICE').recordCaller();
        await sim.circuits.impure.recordCaller();
        const secondCaller = await recorded(sim);
        open();
        await first;

        expect(secondCaller).toBe(defaultCaller);
        expect(await recorded(sim)).toBe(sim.signers.resolveDryKey('ALICE'));
      });

      it('keeps an as() caller set while it is pending for the next call', async () => {
        const sim = await Guarded.create();

        const first = sim.as('ALICE').recordCaller();
        sim.as('BOB');
        await first;
        const firstCaller = await recorded(sim);
        await sim.circuits.impure.recordCaller();

        expect(firstCaller).toBe(sim.signers.resolveDryKey('ALICE'));
        expect(await recorded(sim)).toBe(sim.signers.resolveDryKey('BOB'));
      });

      it('lets an as() inside it choose the caller of its circuit', async () => {
        const Inner = defineSimulator(FlatArtifact, {
          witnesses: FlatWitnesses,
          privateState: FlatPrivateState.generate,
          extend: (sim) => ({
            recordCaller: async (): Promise<[]> => {
              await sim.getPublicState();
              return sim.as('BOB').circuits.impure.recordCaller();
            },
          }),
        });
        const sim = await Inner.create();

        await sim.as('ALICE').recordCaller();

        expect(await recorded(sim)).toBe(sim.signers.resolveDryKey('BOB'));
      });
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
  it('merge per-part factories for createSimulator', async () => {
    type State = CountPrivateState & SecretPrivateState;
    const Composed = createSimulator<
      State,
      DefineArtifact.Ledger,
      DefineArtifact.Witnesses<State>,
      DefineArtifact.Contract<State>,
      [Uint8Array, bigint[], DefineArtifact.Point]
    >({
      contractFactory: (witnesses) =>
        new DefineArtifact.Contract<State>(witnesses),
      defaultPrivateState: composePrivateState(
        CountPrivateState.generate,
        SecretPrivateState.generate,
      ),
      contractArgs: (owner, values, origin) => [owner, values, origin],
      ledgerExtractor: (state) => DefineArtifact.ledger(state),
      witnessesFactory: composeWitnesses(CountingWitnesses, SecretWitnesses),
    });
    const sim = await Composed.create([OWNER, VALUES, ORIGIN]);

    expect(await sim.circuits.impure.storeCount()).toBe(3n);
    expect(await sim.circuits.impure.storeSecret()).toBe(7n);
    expect(await sim.getPrivateState()).toEqual({ count: 4n, secret: 7n });
  });

  it('keep the parts in order', () => {
    const merged = composeWitnesses(CountWitnesses, SecretWitnesses);

    expect(merged.parts).toEqual([CountWitnesses, SecretWitnesses]);
  });

  it('names an anonymous part by its position, when composed', () => {
    expect(() =>
      composeWitnesses(
        () => ({ wit_a: () => 1 }),
        () => ({ wit_a: () => 2 }),
      ),
    ).toThrow('witness "wit_a" is defined by both part 0 and part 1');
  });

  it('merge a symbol private-state key and reject one two parts define', () => {
    const tag = Symbol('tag');
    const merged = composePrivateState(
      () => ({ [tag]: 1n }),
      CountPrivateState.generate,
    )();

    expect(merged[tag]).toBe(1n);
    expect(() =>
      composePrivateState(
        () => ({ [tag]: 1n }),
        () => ({ [tag]: 2n }),
      ),
    ).toThrow(
      'private state key "Symbol(tag)" is defined by both part 0 and part 1',
    );
  });

  it('keep an own __proto__ private-state key as data', () => {
    const merged = composePrivateState(
      (): object => JSON.parse('{"__proto__": {"admin": true}}'),
      CountPrivateState.generate,
    )();

    expect(Object.hasOwn(merged, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });
});
