import type { PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveContext } from '../../src/live/createLiveContext.js';

const contracts = vi.hoisted(() => ({
  findDeployedContract: vi.fn(),
  createCallTxOptions: vi.fn(),
  submitCallTx: vi.fn(),
}));

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => contracts);

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

describe('createLiveContext encryption-key mappings', () => {
  const COMPILED = { name: 'compiled' };
  const MAPPINGS = new Map([['bob-coin-key', 'bob-enc-key']]);
  const deployed = { callTx: { deposit: vi.fn(), getParent: vi.fn() } };

  const liveContext = (mappings?: ReadonlyMap<string, string>) =>
    createLiveContext<PS>({
      contractAddress: '0200cafef00d',
      providersFor: (alias) => ({ alias }),
      compiledContract: COMPILED,
      privateStateId: 'my-contract',
      publicDataProvider: {} as never,
      privateStateProvider: fakeProvider().provider,
      additionalCoinEncPublicKeyMappings: mappings,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    contracts.findDeployedContract.mockResolvedValue(deployed);
  });

  it('returns the deployed handle as-is without mappings', async () => {
    const handle = await liveContext().handleFor(null);

    expect(handle).toBe(deployed);
    expect(contracts.findDeployedContract).toHaveBeenCalledWith(
      { alias: null },
      {
        compiledContract: COMPILED,
        contractAddress: '0200cafef00d',
        privateStateId: 'my-contract',
      },
    );
  });

  it('submits every circuit call with the mappings through the alias providers', async () => {
    const callOptions = { circuitId: 'deposit' };
    const finalized = { private: { result: [] } };
    contracts.createCallTxOptions.mockReturnValue(callOptions);
    contracts.submitCallTx.mockResolvedValue(finalized);

    const handle = await liveContext(MAPPINGS).handleFor('ALICE');
    const result = await handle.callTx.deposit?.('coin');

    expect(Object.keys(handle.callTx)).toStrictEqual(['deposit', 'getParent']);
    expect(contracts.createCallTxOptions).toHaveBeenCalledWith(
      COMPILED,
      'deposit',
      '0200cafef00d',
      'my-contract',
      MAPPINGS,
      ['coin'],
    );
    expect(contracts.submitCallTx).toHaveBeenCalledWith(
      { alias: 'ALICE' },
      callOptions,
    );
    expect(result).toBe(finalized);
    expect(deployed.callTx.deposit).not.toHaveBeenCalled();
  });
});
