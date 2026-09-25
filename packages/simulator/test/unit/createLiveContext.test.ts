import type { Contract } from '@midnight-ntwrk/compact-js';
import type {
  ContractProviders,
  FindDeployedContractOptionsExistingPrivateState,
  ScopedTransactionOptions,
} from '@midnight-ntwrk/midnight-js-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveContext } from '../../src/live/createLiveContext.js';

const contracts = vi.hoisted(() => ({
  findDeployedContract: vi.fn(),
  withContractScopedTransaction: vi.fn(),
}));

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => contracts);

type PS = { secretKey: Uint8Array };
type C = Contract<PS>;

const CONTRACT_ADDRESS = '0200cafef00d';
const PRIVATE_STATE_ID = 'my-contract';

const findOptions = {
  compiledContract: { name: 'compiled' },
  contractAddress: CONTRACT_ADDRESS,
  privateStateId: PRIVATE_STATE_ID,
} as unknown as FindDeployedContractOptionsExistingPrivateState<C>;

/**
 * Per-alias provider bundles holding only the slices `createLiveContext` uses:
 * an in-memory private-state store and a public-data reader. midnight-js-contracts
 * is mocked, so no real provider is built.
 */
const fakeProviders = (contractState: unknown = null) => {
  const store = new Map<string, PS>();
  const bundles = new Map<string | null, ContractProviders<C>>();
  const providersFor = vi.fn((alias: string | null) => {
    let bundle = bundles.get(alias);
    if (!bundle) {
      bundle = {
        alias,
        privateStateProvider: {
          async get(id: string) {
            return store.get(id) ?? null;
          },
          async set(id: string, state: PS) {
            store.set(id, state);
          },
        },
        publicDataProvider: {
          queryContractState: vi.fn(async () => contractState),
        },
      } as unknown as ContractProviders<C>;
      bundles.set(alias, bundle);
    }
    return bundle;
  });
  return { providersFor, store };
};

describe('createLiveContext', () => {
  const TX_CTX = { txCtx: true };
  const FINALIZED = { private: { result: [] } };
  const OPTIONS: ScopedTransactionOptions = {
    additionalCoinEncPublicKeyMappings: new Map([
      ['bob-coin-key', 'bob-enc-key'],
    ]),
  };
  const deployed = { callTx: { deposit: vi.fn(), getParent: vi.fn() } };

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

  it('exposes the contract address from findOptions', () => {
    const { providersFor } = fakeProviders();
    const ctx = createLiveContext({ providersFor, findOptions });

    expect(ctx.contractAddress).toBe(CONTRACT_ADDRESS);
  });

  it('finds the contract with findOptions and the alias providers', async () => {
    const { providersFor } = fakeProviders();
    const handle = await createLiveContext({
      providersFor,
      findOptions,
    }).handleFor('ALICE');

    expect(handle).toBe(deployed);
    expect(contracts.findDeployedContract).toHaveBeenCalledOnce();
    const [providers, options] =
      contracts.findDeployedContract.mock.calls[0] ?? [];
    expect(providers).toBe(providersFor('ALICE'));
    expect(options).toBe(findOptions);
  });

  it('runs every circuit call in its own scoped transaction with the options', async () => {
    const { providersFor } = fakeProviders();
    const handle = await createLiveContext({
      providersFor,
      findOptions,
      scopedTransactionOptions: OPTIONS,
    }).handleFor('ALICE');

    expect(await handle.callTx.deposit?.('coin')).toBe(FINALIZED);
    expect(await handle.callTx.getParent?.()).toBe(FINALIZED);

    expect(deployed.callTx.deposit).toHaveBeenCalledWith(TX_CTX, 'coin');
    expect(deployed.callTx.getParent).toHaveBeenCalledWith(TX_CTX);
    const scopes = contracts.withContractScopedTransaction.mock.calls;
    expect(scopes).toHaveLength(2);
    for (const [providers, , options] of scopes) {
      expect(providers).toBe(providersFor('ALICE'));
      expect(options).toBe(OPTIONS);
    }
  });

  it("reads the ledger through the default signer's public-data provider", async () => {
    const data = { ledger: true };
    const { providersFor } = fakeProviders({ data });
    const ctx = createLiveContext({ providersFor, findOptions });

    expect(await ctx.queryLedger()).toBe(data);
    expect(
      providersFor(null).publicDataProvider.queryContractState,
    ).toHaveBeenCalledWith(CONTRACT_ADDRESS);
  });

  it("writes and reads private state through the default signer's provider", async () => {
    const { providersFor, store } = fakeProviders();
    const ctx = createLiveContext({ providersFor, findOptions });
    const state = { secretKey: Uint8Array.of(9, 9, 9) };

    await ctx.setPrivateState?.(state);

    expect(store.get(PRIVATE_STATE_ID)).toBe(state);
    expect(await ctx.queryPrivateState()).toBe(state);
    expect(providersFor.mock.calls).toStrictEqual([[null], [null]]);
  });

  it('rejects a private-state read when nothing is stored', async () => {
    const { providersFor } = fakeProviders();
    const ctx = createLiveContext({ providersFor, findOptions });

    await expect(ctx.queryPrivateState()).rejects.toThrow(
      `no private state stored at "${PRIVATE_STATE_ID}"`,
    );
  });
});
