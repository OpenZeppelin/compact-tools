import type { ScopedTransactionOptions } from '@midnight-ntwrk/midnight-js-contracts';
import type { PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveContext } from '../../src/live/createLiveContext.js';

const contracts = vi.hoisted(() => ({
  findDeployedContract: vi.fn(),
  withContractScopedTransaction: vi.fn(),
}));

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => contracts);

type PS = { secretKey: Uint8Array };

/**
 * An in-memory stand-in for the harness's `PrivateStateProvider`, exercising
 * only the `get`/`set` slice `createLiveContext` uses. midnight-js-contracts is
 * mocked; the private-state tests never reach it.
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

describe('createLiveContext scoped-transaction options', () => {
  const COMPILED = { name: 'compiled' };
  const TX_CTX = { txCtx: true };
  const FINALIZED = { private: { result: [] } };
  const OPTIONS: ScopedTransactionOptions = {
    additionalCoinEncPublicKeyMappings: new Map([
      ['bob-coin-key', 'bob-enc-key'],
    ]),
  };
  const deployed = { callTx: { deposit: vi.fn(), getParent: vi.fn() } };

  const liveContext = (scopedTransactionOptions?: ScopedTransactionOptions) =>
    createLiveContext<PS>({
      contractAddress: '0200cafef00d',
      providersFor: (alias) => ({ alias }),
      compiledContract: COMPILED,
      privateStateId: 'my-contract',
      publicDataProvider: {} as never,
      privateStateProvider: fakeProvider().provider,
      scopedTransactionOptions,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    contracts.findDeployedContract.mockResolvedValue(deployed);
    contracts.withContractScopedTransaction.mockImplementation(
      async (_providers, fn: (txCtx: unknown) => Promise<void>) => {
        await fn(TX_CTX);
        return FINALIZED;
      },
    );
  });

  it('returns the deployed handle as-is without options', async () => {
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

  it('runs every circuit call in its own scoped transaction with the options', async () => {
    const handle = await liveContext(OPTIONS).handleFor('ALICE');

    expect(await handle.callTx.deposit?.('coin')).toBe(FINALIZED);
    expect(await handle.callTx.getParent?.()).toBe(FINALIZED);

    expect(deployed.callTx.deposit).toHaveBeenCalledWith(TX_CTX, 'coin');
    expect(deployed.callTx.getParent).toHaveBeenCalledWith(TX_CTX);
    const scopes = contracts.withContractScopedTransaction.mock.calls;
    expect(scopes).toHaveLength(2);
    for (const [providers, , options] of scopes) {
      expect(providers).toBe(contracts.findDeployedContract.mock.calls[0]?.[0]);
      expect(options).toBe(OPTIONS);
    }
  });
});
