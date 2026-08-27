import type { StateValue } from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';
import { PRIVATE_STATE_MUTATION_UNSUPPORTED } from '../../src/index.js';
import type {
  DeployedTxHandle,
  LiveContext,
} from '../../src/live/LiveContext.js';
import { WitnessPrivateState } from '../fixtures/sample-contracts/witnesses/WitnessWitnesses.js';
import { WitnessSimulator } from './WitnessSimulator.js';

/**
 * A mutable in-memory live world. Only the private-state read/write paths are
 * exercised here, so `handleFor`/`queryLedger` are inert stubs (no node, no
 * midnight-js). `backend: 'live'` is forced via options so this runs under the
 * dry test runner while still driving the LiveBackend code path.
 */
const makeWorld = (
  initial: WitnessPrivateState,
  opts: { mutable?: boolean } = {},
): LiveContext<WitnessPrivateState> => {
  let stored = initial;
  const world: LiveContext<WitnessPrivateState> = {
    contractAddress: '0200deadbeef',
    async handleFor(): Promise<DeployedTxHandle> {
      return { callTx: {} };
    },
    async queryLedger(): Promise<StateValue> {
      return {} as unknown as StateValue;
    },
    async queryPrivateState(): Promise<WitnessPrivateState> {
      return stored;
    },
  };
  if (opts.mutable !== false) {
    world.setPrivateState = async (state) => {
      stored = state;
    };
  }
  return world;
};

describe('private-state mutation over the live backend (mock world)', () => {
  it('round-trips updatePrivateState read-modify-write through the provider', async () => {
    const world = makeWorld(WitnessPrivateState.generate());
    const sim = await WitnessSimulator.create({ backend: 'live', live: world });
    expect(sim.backendKind).toBe('live');

    await sim.updatePrivateState({ secretField: 999n });

    expect((await sim.getPrivateState()).secretField).toEqual(999n);
  });

  it('composes the updater form over live', async () => {
    const world = makeWorld({
      ...WitnessPrivateState.generate(),
      secretUint: 5n,
    });
    const sim = await WitnessSimulator.create({ backend: 'live', live: world });

    await sim.updatePrivateState((p) => ({
      ...p,
      secretUint: p.secretUint + 10n,
    }));

    expect((await sim.getPrivateState()).secretUint).toEqual(15n);
  });

  it('preserves untouched fields when patching over live', async () => {
    const seed = WitnessPrivateState.generate();
    const world = makeWorld(seed);
    const sim = await WitnessSimulator.create({ backend: 'live', live: world });

    await sim.updatePrivateState({ secretField: 42n });

    const after = await sim.getPrivateState();
    expect(after.secretField).toEqual(42n);
    expect(after.secretBytes).toEqual(seed.secretBytes);
    expect(after.secretUint).toEqual(seed.secretUint);
  });

  it('throws through updatePrivateState when the world opts out of mutation', async () => {
    const world = makeWorld(WitnessPrivateState.generate(), { mutable: false });
    const sim = await WitnessSimulator.create({ backend: 'live', live: world });

    await expect(sim.updatePrivateState({ secretField: 1n })).rejects.toThrow(
      PRIVATE_STATE_MUTATION_UNSUPPORTED,
    );
    // Full-replace path throws too.
    await expect(
      sim.setPrivateState({
        ...(await sim.getPrivateState()),
        secretField: 1n,
      }),
    ).rejects.toThrow(PRIVATE_STATE_MUTATION_UNSUPPORTED);
  });
});
