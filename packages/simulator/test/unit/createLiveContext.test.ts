import type { PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import { describe, expect, it } from 'vitest';
import { createLiveContext } from '../../src/live/createLiveContext.js';

type PS = { secretKey: Uint8Array };

/**
 * An in-memory stand-in for the harness's `PrivateStateProvider`, exercising
 * only the `get`/`set` slice `createLiveContext` uses. `findDeployedContract`
 * (and thus midnight-js) is never reached, so these tests run without the
 * optional live peers installed.
 */
const fakeProvider = (initial: Record<string, PS> = {}) => {
  const store = new Map<string, PS>(Object.entries(initial));
  const calls: Array<{ id: string; state: PS }> = [];
  const provider = {
    async get(id: string) {
      return store.get(id) ?? null;
    },
    async set(id: string, state: PS) {
      calls.push({ id, state });
      store.set(id, state);
    },
  } as unknown as PrivateStateProvider<string, PS>;
  return { provider, calls };
};

const makeContext = (provider: PrivateStateProvider<string, PS>) =>
  createLiveContext<PS>({
    contractAddress: '0200cafef00d',
    providersFor: () => ({}),
    compiledContract: {},
    privateStateId: 'my-contract',
    publicDataProvider: {} as never,
    privateStateProvider: provider,
  });

describe('createLiveContext private-state write', () => {
  it('writes the whole private state to the provider under privateStateId', async () => {
    const { provider, calls } = fakeProvider();
    const ctx = makeContext(provider);

    const sk = Uint8Array.of(1, 2, 3);
    await ctx.setPrivateState?.({ secretKey: sk });

    expect(calls).toEqual([{ id: 'my-contract', state: { secretKey: sk } }]);
  });

  it('is observable by queryPrivateState (read-after-write parity)', async () => {
    const { provider } = fakeProvider({
      'my-contract': { secretKey: Uint8Array.of(0) },
    });
    const ctx = makeContext(provider);

    const sk = Uint8Array.of(9, 9, 9);
    await ctx.setPrivateState?.({ secretKey: sk });

    expect(await ctx.queryPrivateState()).toEqual({ secretKey: sk });
  });
});
