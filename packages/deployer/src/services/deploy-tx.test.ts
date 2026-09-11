import { ContractExecutable } from '@midnight-ntwrk/compact-js';
import {
  ContractOperation as RuntimeContractOperation,
  ContractState as RuntimeContractState,
} from '@midnight-ntwrk/compact-runtime';
import {
  createUnprovenDeployTx,
  submitTxAsync,
} from '@midnight-ntwrk/midnight-js-contracts';
import { makeContractExecutableRuntime } from '@midnight-ntwrk/midnight-js-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractConfig } from '../config/schema.ts';
import {
  BlockLimitError,
  ConfigError,
  DeployError,
  DeployTxFailedError,
  FragmentDeployError,
} from '../errors.ts';
import type { Artifact } from '../loaders/artifact.ts';
import {
  awaitDeployFinalization,
  awaitFragmentFinalization,
  buildExplorerUrl,
  persistDeployPrivateState,
  type SubmittedDeploy,
  submitDeploy,
  toConfirmedRecord,
  toPartialRecord,
  toPendingRecord,
} from './deploy-tx.ts';

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => ({
  createUnprovenDeployTx: vi.fn(),
  submitTxAsync: vi.fn(),
}));

vi.mock('@midnight-ntwrk/compact-js', () => ({
  ContractExecutable: { make: vi.fn() },
}));

// `exitResultOrError` unwraps an effect Exit; the fake runtime below already
// resolves to the unwrapped shape, so identity is the right stand-in.
vi.mock('@midnight-ntwrk/midnight-js-types', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@midnight-ntwrk/midnight-js-types')>();
  return {
    ...actual,
    makeContractExecutableRuntime: vi.fn(),
    exitResultOrError: <T>(exit: T): T => exit,
  };
});

vi.mock('@midnight-ntwrk/midnight-js-network-id', () => ({
  getNetworkId: vi.fn(() => 'undeployed'),
}));

vi.mock('@midnight-ntwrk/midnight-js-utils', () => ({
  parseCoinPublicKeyToHex: vi.fn(() => '00'.repeat(32)),
  ttlOneHour: vi.fn(() => new Date(Date.now() + 3_600_000)),
}));

function fakeUnsubmitted(address = '0xCONTRACT') {
  return {
    public: { contractAddress: address },
    private: {
      unprovenTx: { tag: 'unproven' },
      signingKey: 'signing-key',
      initialPrivateState: { seeded: true },
    },
  };
}

function fakeSubmitted(address = '0xCONTRACT'): SubmittedDeploy {
  return {
    address,
    txId: '0xTX',
    unsubmitted: fakeUnsubmitted(address),
  } as unknown as SubmittedDeploy;
}

function fakeFinalized(overrides: Record<string, unknown> = {}) {
  return {
    status: 'SucceedEntirely',
    txId: '0xTX',
    txHash: '0xHASH',
    blockHeight: 1234,
    ...overrides,
  };
}

function submitArgs(
  contract: Partial<ContractConfig> = {},
): Parameters<typeof submitDeploy>[0] {
  return {
    providers: { tag: 'providers' } as never,
    contractName: 'Counter',
    contract: { artifact: 'Counter', ...contract } as ContractConfig,
    artifact: {
      compiledContract: { fake: 'compiled' },
      circuitNames: ['increment'],
    } as unknown as Artifact,
    signingKey: 'aa'.repeat(32),
    args: [1, 2],
    initialPrivateState: { seeded: true },
    circuits: ['increment'],
  };
}

/** Providers whose `watchForTxData` resolution the test controls. */
function watchProviders(watchForTxData: () => Promise<unknown>) {
  return { publicDataProvider: { watchForTxData } } as never;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('submitDeploy', () => {
  it('should return the address and txId as soon as the node accepts the tx', async () => {
    vi.mocked(createUnprovenDeployTx).mockResolvedValue(
      fakeUnsubmitted() as never,
    );
    vi.mocked(submitTxAsync).mockResolvedValue('0xTX');

    const submitted = await submitDeploy(submitArgs());

    expect(submitted.address).toBe('0xCONTRACT');
    expect(submitted.txId).toBe('0xTX');
    expect(createUnprovenDeployTx).toHaveBeenCalledWith(
      { tag: 'providers' },
      {
        compiledContract: { fake: 'compiled' },
        signingKey: 'aa'.repeat(32),
        args: [1, 2],
      },
    );
    expect(submitTxAsync).toHaveBeenCalledWith(
      { tag: 'providers' },
      { unprovenTx: { tag: 'unproven' } },
    );
  });

  it('should omit initialPrivateState when no private_state_id is configured', async () => {
    vi.mocked(createUnprovenDeployTx).mockResolvedValue(
      fakeUnsubmitted() as never,
    );
    vi.mocked(submitTxAsync).mockResolvedValue('0xTX');

    await submitDeploy(submitArgs());

    const options = vi.mocked(createUnprovenDeployTx).mock.calls[0]?.[1];
    expect(options).not.toHaveProperty('initialPrivateState');
    // privateStateId belongs to submitDeployTx, not to the unproven-tx call.
    expect(options).not.toHaveProperty('privateStateId');
  });

  it('should pass the initial state when private_state_id is configured', async () => {
    vi.mocked(createUnprovenDeployTx).mockResolvedValue(
      fakeUnsubmitted() as never,
    );
    vi.mocked(submitTxAsync).mockResolvedValue('0xTX');

    await submitDeploy(submitArgs({ private_state_id: 'counter-state' }));

    expect(createUnprovenDeployTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ initialPrivateState: { seeded: true } }),
    );
  });

  it('should wrap a proving failure in DeployTxFailedError, keeping the cause', async () => {
    const cause = new Error('proof server said no');
    vi.mocked(createUnprovenDeployTx).mockRejectedValue(cause);

    const thrown = await submitDeploy(submitArgs()).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(DeployTxFailedError);
    expect((thrown as DeployTxFailedError).message).toBe(
      'Deploy of "Counter" failed: proof server said no',
    );
    expect((thrown as DeployTxFailedError).cause).toBe(cause);
  });

  it('should render a tagged wallet-SDK rejection in the wrapped message', async () => {
    vi.mocked(createUnprovenDeployTx).mockResolvedValue(
      fakeUnsubmitted() as never,
    );
    vi.mocked(submitTxAsync).mockRejectedValue({
      _tag: 'Wallet.Sync',
      message: 'Could not deserialize Ledger Event',
    });

    const thrown = await submitDeploy(submitArgs()).catch((e: unknown) => e);

    expect((thrown as DeployTxFailedError).message).toBe(
      'Deploy of "Counter" failed: Wallet.Sync: Could not deserialize Ledger Event',
    );
  });
});

describe('awaitDeployFinalization', () => {
  it('should return the finalization data on a SucceedEntirely status', async () => {
    const finalized = await awaitDeployFinalization({
      providers: watchProviders(async () => fakeFinalized()),
      contractName: 'Counter',
      submitted: fakeSubmitted(),
      txTimeoutMs: 1000,
      recovery: 'pending',
    });
    expect(finalized.txHash).toBe('0xHASH');
    expect(finalized.blockHeight).toBe(1234);
  });

  it('should name the address, the txId and the pending record when the node rejects the tx', async () => {
    const thrown = await awaitDeployFinalization({
      providers: watchProviders(async () =>
        fakeFinalized({ status: 'FailEntirely' }),
      ),
      contractName: 'Counter',
      submitted: fakeSubmitted(),
      txTimeoutMs: 1000,
      recovery: 'pending',
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(DeployTxFailedError);
    const { message } = thrown as DeployTxFailedError;
    expect(message).toContain('FailEntirely');
    expect(message).toContain('0xCONTRACT');
    expect(message).toContain('0xTX');
    expect(message).toContain('pending record');
  });

  it('should name the address and the txId when the watch itself rejects', async () => {
    const thrown = await awaitDeployFinalization({
      providers: watchProviders(async () => {
        throw new Error('socket closed');
      }),
      contractName: 'Counter',
      submitted: fakeSubmitted(),
      txTimeoutMs: 1000,
      recovery: 'pending',
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(DeployTxFailedError);
    expect((thrown as DeployTxFailedError).message).toContain('socket closed');
    expect((thrown as DeployTxFailedError).message).toContain('0xTX');
    expect((thrown as DeployTxFailedError).cause).toBeInstanceOf(Error);
  });

  it('should give up on a watch that never settles once txTimeoutMs passes', async () => {
    const thrown = await awaitDeployFinalization({
      providers: watchProviders(() => new Promise(() => {})),
      contractName: 'Counter',
      submitted: fakeSubmitted(),
      txTimeoutMs: 5,
      recovery: 'pending',
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(DeployTxFailedError);
    expect((thrown as DeployTxFailedError).message).toContain(
      'no finalization within 5 ms',
    );
    expect((thrown as DeployTxFailedError).message).toContain('0xTX');
  });
});

describe('persistDeployPrivateState', () => {
  function fakePrivateStateProvider() {
    return {
      setContractAddress: vi.fn(),
      set: vi.fn(async () => undefined),
      setSigningKey: vi.fn(async () => undefined),
    };
  }

  it('should scope the store to the address and store the signing key', async () => {
    const privateStateProvider = fakePrivateStateProvider();
    await persistDeployPrivateState({
      providers: { privateStateProvider } as never,
      contract: { artifact: 'Counter' } as ContractConfig,
      submitted: fakeSubmitted(),
    });

    expect(privateStateProvider.setContractAddress).toHaveBeenCalledWith(
      '0xCONTRACT',
    );
    expect(privateStateProvider.setSigningKey).toHaveBeenCalledWith(
      '0xCONTRACT',
      'signing-key',
    );
    expect(privateStateProvider.set).not.toHaveBeenCalled();
  });

  it('should store the initial private state under the configured id', async () => {
    const privateStateProvider = fakePrivateStateProvider();
    await persistDeployPrivateState({
      providers: { privateStateProvider } as never,
      contract: {
        artifact: 'Counter',
        private_state_id: 'counter-state',
      } as ContractConfig,
      submitted: fakeSubmitted(),
    });

    expect(privateStateProvider.set).toHaveBeenCalledWith('counter-state', {
      seeded: true,
    });
  });
});

describe('buildExplorerUrl', () => {
  it('should return an empty string when no explorer is configured', () => {
    expect(buildExplorerUrl(undefined, '0xCONTRACT')).toBe('');
  });

  it('should return an empty string when the address is empty', () => {
    expect(buildExplorerUrl('https://explorer.example', '')).toBe('');
  });

  it('should NOT double-prefix an address that already starts with 0x', () => {
    expect(buildExplorerUrl('https://explorer.example', '0xCONTRACT')).toBe(
      'https://explorer.example/contracts/0xCONTRACT',
    );
  });

  it('should add the 0x prefix when the address lacks one', () => {
    expect(buildExplorerUrl('https://explorer.example', 'BARE')).toBe(
      'https://explorer.example/contracts/0xBARE',
    );
  });

  it('should strip a trailing slash from the explorer base', () => {
    expect(buildExplorerUrl('https://explorer.example/', '0xCONTRACT')).toBe(
      'https://explorer.example/contracts/0xCONTRACT',
    );
  });
});

describe('deployment records', () => {
  it('should build a pending record from what submission alone yields', () => {
    const record = toPendingRecord({
      submitted: fakeSubmitted(),
      deployer: '0xDEPLOYER',
      artifact: 'src/artifacts/Counter/Counter',
    });
    expect(record).toMatchObject({
      status: 'pending',
      address: '0xCONTRACT',
      txId: '0xTX',
      deployer: '0xDEPLOYER',
      artifact: 'src/artifacts/Counter/Counter',
    });
    expect(record.submittedAt).toBe(new Date(record.submittedAt).toISOString());
  });

  it('should carry the pending fields plus the on-chain ones into the confirmed record', () => {
    const pending = toPendingRecord({
      submitted: fakeSubmitted(),
      deployer: '0xDEPLOYER',
      artifact: 'src/artifacts/Counter/Counter',
    });
    const record = toConfirmedRecord({
      previous: pending,
      txHash: '0xHASH',
      blockHeight: 1234,
    });
    expect(record).toMatchObject({
      status: 'confirmed',
      address: '0xCONTRACT',
      txId: '0xTX',
      txHash: '0xHASH',
      blockHeight: 1234,
      deployer: '0xDEPLOYER',
      artifact: 'src/artifacts/Counter/Counter',
    });
    expect(record.timestamp).toBe(new Date(record.timestamp).toISOString());
  });

  it('should never carry a signing key into either ledger record', () => {
    const pending = toPendingRecord({
      submitted: fakeSubmitted(),
      deployer: '0xDEPLOYER',
      artifact: 'Counter',
    });
    expect(Object.keys(pending).sort()).toEqual([
      'address',
      'artifact',
      'deployer',
      'status',
      'submittedAt',
      'txId',
    ]);
    const record = toConfirmedRecord({
      previous: pending,
      txHash: '0xHASH',
      blockHeight: 1234,
    });
    expect(Object.keys(record).sort()).toEqual([
      'address',
      'artifact',
      'blockHeight',
      'deployer',
      'status',
      'timestamp',
      'txHash',
      'txId',
    ]);
  });
});

const ALL_CIRCUITS = ['approve', 'burn', 'charge', 'deposit', 'evict'];

/** Constructor output shaped like `ContractExecutable.initialize` returns it. */
function constructorResult(
  zswap: { inputs: unknown[]; outputs: unknown[] } = {
    inputs: [],
    outputs: [],
  },
) {
  const contractState = new RuntimeContractState();
  for (const name of ALL_CIRCUITS) {
    contractState.setOperation(name, new RuntimeContractOperation());
  }
  return {
    public: { contractState },
    private: {
      signingKey: 'aa'.repeat(32),
      privateState: { seeded: true },
      zswapLocalState: zswap,
    },
  };
}

/** Wire the compact-js executable + runtime mocks to one constructor result. */
function stubConstructor(result = constructorResult()): void {
  vi.mocked(ContractExecutable.make).mockReturnValue({
    initialize: vi.fn(() => ({ tag: 'effect' })),
  } as never);
  vi.mocked(makeContractExecutableRuntime).mockReturnValue({
    runPromiseExit: vi.fn(async () => result),
  } as never);
}

function splitArgs(
  circuits: readonly string[] = ['approve', 'burn'],
): Parameters<typeof submitDeploy>[0] {
  return {
    ...submitArgs(),
    artifact: {
      compiledContract: { fake: 'compiled' },
      circuitNames: ALL_CIRCUITS,
    } as unknown as Artifact,
    providers: {
      walletProvider: { getCoinPublicKey: () => 'bech32-coin-key' },
      zkConfigProvider: { tag: 'zk' },
    } as never,
    circuits,
  };
}

describe('submitDeploy on a pruned fragment', () => {
  // INV-7, INV-14
  it('deploys the pruned state and returns its address', async () => {
    stubConstructor();
    vi.mocked(submitTxAsync).mockResolvedValue('0xTX');

    const submitted = await submitDeploy(splitArgs());

    expect(createUnprovenDeployTx).not.toHaveBeenCalled();
    expect(submitted.txId).toBe('0xTX');
    expect(submitted.address).toMatch(/^[0-9a-f]+$/);
    const rendered = String(
      vi.mocked(submitTxAsync).mock.calls[0]?.[1].unprovenTx,
    );
    expect(rendered).toContain('Deploy ContractState');
    expect(rendered).not.toContain('MaintenanceUpdate');
    // INV-7: the deploy tx carries fragment 0's operations and no others.
    expect(rendered).toContain('approve:');
    expect(rendered).toContain('burn:');
    for (const dropped of ['charge', 'deposit', 'evict']) {
      expect(rendered).not.toContain(dropped);
    }
  });

  // INV-8
  it('refuses a constructor that creates a Zswap coin', async () => {
    stubConstructor(
      constructorResult({ inputs: [], outputs: [{ coinInfo: {} }] }),
    );

    const thrown = await submitDeploy(splitArgs()).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain('1 Zswap coin(s)');
    expect(submitTxAsync).not.toHaveBeenCalled();
  });

  // INV-8
  it('refuses a constructor that spends a Zswap coin', async () => {
    stubConstructor(
      constructorResult({ inputs: [{ nonce: '0x' }], outputs: [] }),
    );

    await expect(submitDeploy(splitArgs())).rejects.toThrow(ConfigError);
  });

  // INV-7
  it('surfaces a fragment naming an unknown circuit as a bug, not a tx failure', async () => {
    stubConstructor();

    const thrown = await submitDeploy(splitArgs(['nope'])).catch(
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(DeployError);
    expect(thrown).not.toBeInstanceOf(DeployTxFailedError);
  });

  it('passes the initial private state only when configured', async () => {
    stubConstructor();
    vi.mocked(submitTxAsync).mockResolvedValue('0xTX');

    await submitDeploy(splitArgs());
    const executable = vi.mocked(ContractExecutable.make).mock.results[0]
      ?.value as { initialize: ReturnType<typeof vi.fn> };
    expect(executable.initialize).toHaveBeenCalledWith(undefined, 1, 2);

    vi.clearAllMocks();
    stubConstructor();
    vi.mocked(submitTxAsync).mockResolvedValue('0xTX');
    await submitDeploy({
      ...splitArgs(),
      contract: {
        artifact: 'Counter',
        private_state_id: 'counter-state',
      } as ContractConfig,
    });
    const withState = vi.mocked(ContractExecutable.make).mock.results[0]
      ?.value as { initialize: ReturnType<typeof vi.fn> };
    expect(withState.initialize).toHaveBeenCalledWith({ seeded: true }, 1, 2);
  });
});

describe('submitDeploy block-limit classification', () => {
  const BLOCK_LIMIT_TEXT =
    '1010: Invalid Transaction: Transaction would exhaust the block limits';

  // INV-9
  it('raises BlockLimitError naming the fragment size', async () => {
    vi.mocked(createUnprovenDeployTx).mockResolvedValue(
      fakeUnsubmitted() as never,
    );
    vi.mocked(submitTxAsync).mockRejectedValue(new Error(BLOCK_LIMIT_TEXT));

    const thrown = await submitDeploy(submitArgs()).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(BlockLimitError);
    expect((thrown as Error).message).toContain('at 1 circuit(s)');
    expect((thrown as BlockLimitError).exitCode).toBe(7);
  });

  // INV-9
  it('leaves any other 1010 as a plain tx failure', async () => {
    vi.mocked(createUnprovenDeployTx).mockResolvedValue(
      fakeUnsubmitted() as never,
    );
    vi.mocked(submitTxAsync).mockRejectedValue(
      new Error('1010: Invalid Transaction: Custom error 103'),
    );

    const thrown = await submitDeploy(submitArgs()).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(DeployTxFailedError);
    expect(thrown).not.toBeInstanceOf(BlockLimitError);
  });
});

describe('awaitFragmentFinalization', () => {
  const fragmentArgs = {
    address: '0xCONTRACT',
    txId: '0xINSERT',
    circuitsOnChain: ['approve'],
    circuitsPending: ['burn'],
  };

  // INV-12
  it('returns the finalization data on SucceedEntirely', async () => {
    const finalized = await awaitFragmentFinalization({
      providers: watchProviders(async () => fakeFinalized()),
      ...fragmentArgs,
      txTimeoutMs: 1000,
    });

    expect(finalized.blockHeight).toBe(1234);
  });

  // INV-12
  it('fails a partially applied update rather than treating it as landed', async () => {
    const thrown = await awaitFragmentFinalization({
      providers: watchProviders(async () =>
        fakeFinalized({ status: 'SucceedPartially' }),
      ),
      ...fragmentArgs,
      txTimeoutMs: 1000,
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect((thrown as Error).message).toContain('SucceedPartially');
    expect((thrown as FragmentDeployError).txId).toBe('0xINSERT');
  });

  // INV-12
  it('gives up once txTimeoutMs passes', async () => {
    const thrown = await awaitFragmentFinalization({
      providers: watchProviders(() => new Promise(() => {})),
      ...fragmentArgs,
      txTimeoutMs: 5,
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect((thrown as Error).message).toContain('no finalization within 5 ms');
  });

  // INV-12
  it('wraps a rejecting watch, keeping the cause', async () => {
    const cause = new Error('socket closed');
    const thrown = await awaitFragmentFinalization({
      providers: watchProviders(async () => {
        throw cause;
      }),
      ...fragmentArgs,
      txTimeoutMs: 1000,
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect((thrown as Error).cause).toBe(cause);
  });
});

describe('toPartialRecord', () => {
  const base = {
    address: '0xCONTRACT',
    txId: '0xTX',
    deployer: '0xDEP',
    artifact: 'src/artifacts/Token/Token',
    circuits: ['charge', 'approve', 'burn'],
  };

  // INV-17
  it('partitions the artifact circuits into landed and pending, both sorted', () => {
    const record = toPartialRecord({ ...base, circuitsOnChain: ['burn'] });

    expect(record.status).toBe('partial');
    expect(record.circuitsOnChain).toStrictEqual(['burn']);
    expect(record.circuitsPending).toStrictEqual(['approve', 'charge']);
    expect(
      [...record.circuitsOnChain, ...record.circuitsPending].sort(),
    ).toStrictEqual(['approve', 'burn', 'charge']);
  });

  // INV-17
  it('records nothing pending once every circuit is on chain', () => {
    const record = toPartialRecord({
      ...base,
      circuitsOnChain: ['approve', 'burn', 'charge'],
    });

    expect(record.circuitsPending).toStrictEqual([]);
  });

  // INV-17
  it('rejects a chain read naming a circuit the artifact does not have', () => {
    expect(() =>
      toPartialRecord({ ...base, circuitsOnChain: ['stranger'] }),
    ).toThrow(DeployError);
  });

  it('records an insert left in flight so a resume can settle it', () => {
    const record = toPartialRecord({
      ...base,
      circuitsOnChain: ['burn'],
      pendingTxId: '0xINSERT',
    });

    expect(record.pendingTxId).toBe('0xINSERT');
    expect(
      toPartialRecord({ ...base, circuitsOnChain: [] }),
    ).not.toHaveProperty('pendingTxId');
  });

  it('keeps the caller submittedAt across progress rewrites', () => {
    const submittedAt = '2026-05-15T00:00:00.000Z';

    expect(
      toPartialRecord({ ...base, circuitsOnChain: [], submittedAt })
        .submittedAt,
    ).toBe(submittedAt);
  });

  // INV-22
  it('carries no signing key', () => {
    const record = toPartialRecord({ ...base, circuitsOnChain: [] });

    expect(JSON.stringify(record)).not.toContain('aa'.repeat(32));
  });
});

describe('toConfirmedRecord from a partial head', () => {
  // INV-16
  it('promotes a partial record, keeping the address and deploy txId', () => {
    const partial = toPartialRecord({
      address: '0xCONTRACT',
      txId: '0xTX',
      deployer: '0xDEP',
      artifact: 'src/artifacts/Token/Token',
      circuits: ['approve'],
      circuitsOnChain: ['approve'],
    });

    const record = toConfirmedRecord({
      previous: partial,
      txHash: '0xHASH',
      blockHeight: 1234,
    });

    expect(record).toMatchObject({
      status: 'confirmed',
      address: '0xCONTRACT',
      txId: '0xTX',
      txHash: '0xHASH',
      blockHeight: 1234,
    });
  });
});
