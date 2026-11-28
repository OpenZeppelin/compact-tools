import {
  dummyContractAddress,
  type StateValue,
  type WitnessContext,
} from '@midnight-ntwrk/compact-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearLiveBackend,
  defineSimulator,
  type LiveBackendRequest,
  type LiveContext,
  registerLiveBackend,
} from '../../src/index.js';
import * as DefineArtifact from '../fixtures/artifacts/Define/contract/index.js';
import {
  CountPrivateState,
  CountWitnesses,
  DefinePrivateState,
  DefineWitnesses,
  SecretPrivateState,
  SecretWitnesses,
} from '../fixtures/sample-contracts/witnesses/DefineWitnesses.js';
import { FlatSimulator } from './FlatSimulator.js';

const OWNER = new Uint8Array(32).fill(1);
const VALUES = [4n, 5n];
const ORIGIN = { x: 1n, y: 2n };

type Call = { alias: string | null; name: string; args: unknown[] };

/**
 * A live world without a node: `callTx` records each call and resolves to a
 * scripted result, the ledger is a fixed contract state, and the private state
 * lives in memory.
 */
const makeWorld = <P>(
  privateState: P,
  ledger: StateValue = {} as StateValue,
  results: Record<string, unknown> = {},
) => {
  const calls: Call[] = [];
  let stored = privateState;
  const ctx: LiveContext<P> = {
    contractAddress: dummyContractAddress(),
    async handleFor(alias) {
      const callTx = new Proxy(
        {},
        {
          get:
            (_target, name) =>
            async (...args: unknown[]) => {
              calls.push({ alias, name: String(name), args });
              if (results[String(name)] instanceof Error) {
                throw results[String(name)];
              }
              return { private: { result: results[String(name)] } };
            },
        },
      );
      return { callTx };
    },
    async queryLedger() {
      return ledger;
    },
    async queryPrivateState() {
      return stored;
    },
    async setPrivateState(next) {
      stored = next;
    },
  };
  return { ctx, calls, stored: () => stored };
};

class DefineSimulator extends defineSimulator(DefineArtifact, {
  witnesses: [CountWitnesses, SecretWitnesses],
  privateState: [CountPrivateState.generate, SecretPrivateState.generate],
  artifactName: 'Define',
}) {}

/** The contract state a fresh deploy leaves, read from a dry instance. */
const deployedState = async (): Promise<StateValue> =>
  (
    await DefineSimulator.create(OWNER, VALUES, ORIGIN, { backend: 'dry' })
  ).getContractState();

describe('defined simulators on the live backend', () => {
  afterEach(() => clearLiveBackend());

  it('routes flat impure methods to callTx and runs pure ones locally', async () => {
    const world = makeWorld(
      DefinePrivateState.generate(),
      await deployedState(),
      {
        storeCount: 41n,
      },
    );
    const sim = await DefineSimulator.create(OWNER, VALUES, ORIGIN, {
      backend: 'live',
      live: world.ctx,
    });

    expect(sim.backendKind).toBe('live');
    expect(sim).toBeInstanceOf(DefineSimulator);
    expect(await sim.storeCount()).toBe(41n);
    expect(await sim.double(4n)).toBe(8n);
    expect(DefineSimulator.double(21n)).toBe(42n);
    expect((await sim.getPublicState())._owner).toEqual(OWNER);
    expect(world.calls).toEqual([
      { alias: null, name: 'storeCount', args: [] },
    ]);
  });

  it('sends one call as the as() caller, the next as the default', async () => {
    const world = makeWorld(DefinePrivateState.generate());
    const sim = await DefineSimulator.create(OWNER, VALUES, ORIGIN, {
      backend: 'live',
      live: world.ctx,
    });

    await sim.as('ALICE').storeSecret();
    await sim.storeCount();

    expect(world.calls.map(({ alias }) => alias)).toEqual(['ALICE', null]);
  });

  it('runs the circuit of an async replacement that awaits first as the as() caller', async () => {
    const Guarded = defineSimulator(DefineArtifact, {
      witnesses: [CountWitnesses, SecretWitnesses],
      privateState: [CountPrivateState.generate, SecretPrivateState.generate],
      extend: (sim) => ({
        storeSecret: async (): Promise<bigint> => {
          await sim.getPrivateState();
          return sim.circuits.impure.storeSecret();
        },
      }),
    });
    const world = makeWorld(DefinePrivateState.generate());
    const sim = await Guarded.create(OWNER, VALUES, ORIGIN, {
      backend: 'live',
      live: world.ctx,
    });

    const first = sim.as('ALICE').storeSecret();
    const second = sim.storeCount();
    await Promise.all([first, second]);
    await sim.storeCount();

    expect(world.calls).toEqual([
      { alias: null, name: 'storeCount', args: [] },
      { alias: 'ALICE', name: 'storeSecret', args: [] },
      { alias: null, name: 'storeCount', args: [] },
    ]);
  });

  it('drops the as() caller after a failed call', async () => {
    const world = makeWorld(DefinePrivateState.generate(), undefined, {
      storeSecret: new Error('rejected'),
    });
    const sim = await DefineSimulator.create(OWNER, VALUES, ORIGIN, {
      backend: 'live',
      live: world.ctx,
    });

    await expect(sim.as('ALICE').storeSecret()).rejects.toThrow('rejected');
    await sim.storeCount();

    expect(world.calls.map(({ alias }) => alias)).toEqual(['ALICE', null]);
  });

  it('applies prepare, fields and extend', async () => {
    type Wallet = { secret: bigint };
    const walletWitnesses = (wallet: Wallet) => ({
      ...CountWitnesses(),
      wit_secret: ({
        privateState,
      }: WitnessContext<unknown, CountPrivateState>): [
        CountPrivateState,
        bigint,
      ] => [privateState, wallet.secret],
    });
    let prepared: ReturnType<typeof walletWitnesses> | undefined;
    const Prepared = defineSimulator(DefineArtifact, {
      privateState: CountPrivateState.generate,
      extend: (sim) => ({
        privateState: {
          injectCount: (count: bigint) => sim.updatePrivateState({ count }),
        },
        double: (x: bigint): bigint => DefineArtifact.pureCircuits.double(x),
      }),
      prepare: (wallet: Wallet) => {
        prepared = walletWitnesses(wallet);
        return {
          args: [OWNER, VALUES, ORIGIN] as const,
          options: { backend: 'live' as const, witnesses: prepared },
          fields: { wallet },
        };
      },
      artifactName: 'Define',
    });
    const world = makeWorld(CountPrivateState.generate(), undefined, {
      storeSecret: 6n,
    });
    const captured: { request?: LiveBackendRequest } = {};
    registerLiveBackend(async (request) => {
      captured.request = request;
      return world.ctx;
    });
    const wallet = { secret: 6n };

    const sim = await Prepared.create(wallet);
    await sim.privateState.injectCount(9n);

    expect(sim.backendKind).toBe('live');
    expect(sim).toBeInstanceOf(Prepared);
    expect(sim.wallet).toBe(wallet);
    expect(sim.double(5n)).toBe(10n);
    expect(world.stored()).toEqual({ count: 9n });
    expect(await sim.storeSecret()).toBe(6n);
    expect(captured.request?.contractArgs).toEqual([OWNER, VALUES, ORIGIN]);
    expect(captured.request?.options.witnesses).toBe(prepared);
    expect(captured.request?.config.artifactName).toBe('Define');
  });

  it('builds the merged witnesses for the local evaluator', async () => {
    const world = makeWorld(DefinePrivateState.generate());
    const Bundled = defineSimulator(DefineArtifact, {
      witnesses: () => DefineWitnesses(),
      privateState: DefinePrivateState.generate,
    });
    const sim = await Bundled.create(OWNER, VALUES, ORIGIN, {
      backend: 'live',
      live: world.ctx,
    });

    expect(Object.keys(sim.witnesses).sort()).toEqual([
      'wit_count',
      'wit_secret',
    ]);
  });
});

describe('flat createSimulator instances on the live backend', () => {
  it('routes flat methods, keeps a subclass field and runs pure circuits locally', async () => {
    const world = makeWorld({ value: 5n }, undefined, { bump: [] });
    const sim = await FlatSimulator.create({
      backend: 'live',
      live: world.ctx,
    });

    expect(await sim.bump()).toEqual([]);
    expect(await sim.add(1n, 2n)).toBe(3n);
    expect(await sim.labelled()).toBe(100n);
    expect(world.calls).toEqual([{ alias: null, name: 'bump', args: [] }]);
  });
});
