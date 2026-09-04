import {
  createUnprovenDeployTx,
  submitTxAsync,
} from '@midnight-ntwrk/midnight-js-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractConfig } from '../config/schema.ts';
import { DeployTxFailedError } from '../errors.ts';
import type { Artifact } from '../loaders/artifact.ts';
import {
  awaitDeployFinalization,
  buildExplorerUrl,
  persistDeployPrivateState,
  type SubmittedDeploy,
  submitDeploy,
  toConfirmedRecord,
  toPendingRecord,
} from './deploy-tx.ts';

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => ({
  createUnprovenDeployTx: vi.fn(),
  submitTxAsync: vi.fn(),
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
    artifact: { compiledContract: { fake: 'compiled' } } as unknown as Artifact,
    signingKey: 'aa'.repeat(32),
    args: [1, 2],
    initialPrivateState: { seeded: true },
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
      pending,
      finalized: fakeFinalized() as never,
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
      pending,
      finalized: fakeFinalized() as never,
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
