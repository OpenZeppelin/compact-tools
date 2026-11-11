import { ContractState } from '@midnight-ntwrk/compact-runtime';
import type { ScopedTransactionOptions } from '@midnight-ntwrk/midnight-js-contracts';
import type {
  PrivateStateProvider,
  PublicDataProvider,
} from '@midnight-ntwrk/midnight-js-types';
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
 * only the `forContract(address)` view's `get`/`set` slice `createLiveContext`
 * uses. midnight-js-contracts is mocked; the private-state tests never reach it.
 */
const fakeProvider = (initial: Record<string, PS> = {}) => {
  const store = new Map<string, PS>(Object.entries(initial));
  const calls: Array<{ address: string; id: string; state: PS }> = [];
  const provider = {
    forContract(address: string) {
      return {
        async get(id: string) {
          return store.get(id) ?? null;
        },
        async set(id: string, state: PS) {
          calls.push({ address, id, state });
          store.set(id, state);
        },
      };
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
  it("writes the whole private state to the contract's view under privateStateId", async () => {
    const { provider, calls } = fakeProvider();
    const ctx = makeContext(provider);

    const sk = Uint8Array.of(1, 2, 3);
    await ctx.setPrivateState?.({ secretKey: sk });

    expect(calls).toEqual([
      { address: '0200cafef00d', id: 'my-contract', state: { secretKey: sk } },
    ]);
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

describe('createLiveContext public-state read', () => {
  const STATE = { tag: 'state-value' };

  /**
   * A `queryContractState` answering with the bytes-plus-decoder read
   * midnight-js 5.0.0 returns. `deserialize` hands back a runtime
   * `ContractState` look-alike, whose `data` is a charged state wrapping the
   * `StateValue`.
   */
  const fakePublicDataProvider = (...reads: Array<object | null>) => {
    const deserialize = vi.fn(() => ({ data: { state: STATE } }));
    const queryContractState = vi.fn();
    for (const read of reads) {
      queryContractState.mockResolvedValueOnce(
        read === null ? null : { contractState: { deserialize } },
      );
    }
    return {
      provider: { queryContractState } as unknown as PublicDataProvider,
      deserialize,
      queryContractState,
    };
  };

  const readerContext = (publicDataProvider: PublicDataProvider) =>
    createLiveContext<PS>({
      contractAddress: '0200cafef00d',
      providersFor: () => ({}),
      compiledContract: {},
      privateStateId: 'my-contract',
      publicDataProvider,
      privateStateProvider: fakeProvider().provider,
      indexerLag: { retries: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });

  it('decodes the read with the runtime ContractState and returns data.state', async () => {
    const { provider, deserialize, queryContractState } =
      fakePublicDataProvider({});

    expect(await readerContext(provider).queryLedger()).toBe(STATE);

    expect(queryContractState).toHaveBeenCalledWith('0200cafef00d');
    expect(deserialize).toHaveBeenCalledWith({ v9: ContractState });
  });

  it('re-reads past an empty answer before giving up', async () => {
    const { provider, queryContractState } = fakePublicDataProvider(null, {});

    expect(await readerContext(provider).queryLedger()).toBe(STATE);
    expect(queryContractState).toHaveBeenCalledTimes(2);
  });

  it('fails once the retry budget is spent on empty answers', async () => {
    const { provider, queryContractState } = fakePublicDataProvider(null, null);

    await expect(readerContext(provider).queryLedger()).rejects.toThrow(
      /no contract state at 0200cafef00d after 2 attempts/,
    );
    expect(queryContractState).toHaveBeenCalledTimes(2);
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
