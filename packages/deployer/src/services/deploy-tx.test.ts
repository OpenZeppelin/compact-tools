import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractConfig } from '../config/schema.ts';
import { DeployTxFailedError } from '../errors.ts';
import type { Artifact } from '../loaders/artifact.ts';
import {
  buildExplorerUrl,
  type ContractDeployResult,
  executeDeploy,
  toDeploymentRecord,
} from './deploy-tx.ts';

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => ({
  deployContract: vi.fn(),
}));

function fakeDeployTxResult(address = '0xCONTRACT'): ContractDeployResult {
  return {
    deployTxData: {
      public: {
        contractAddress: address,
        txHash: '0xHASH',
        txId: '0xTX',
        blockHeight: 1234,
      },
    },
  } as unknown as ContractDeployResult;
}

function args(
  contract: Partial<ContractConfig> = {},
): Parameters<typeof executeDeploy>[0] {
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

afterEach(() => {
  vi.clearAllMocks();
});

describe('executeDeploy', () => {
  it('should submit the compiled contract, signing key and args', async () => {
    vi.mocked(deployContract).mockResolvedValue(fakeDeployTxResult());
    const result = await executeDeploy(args());
    expect(result).toEqual(fakeDeployTxResult());
    expect(deployContract).toHaveBeenCalledWith(
      { tag: 'providers' },
      {
        compiledContract: { fake: 'compiled' },
        signingKey: 'aa'.repeat(32),
        args: [1, 2],
      },
    );
  });

  it('should omit the private-state options when no private_state_id is configured', async () => {
    vi.mocked(deployContract).mockResolvedValue(fakeDeployTxResult());
    await executeDeploy(args());
    const options = vi.mocked(deployContract).mock.calls[0]?.[1];
    expect(options).not.toHaveProperty('privateStateId');
    expect(options).not.toHaveProperty('initialPrivateState');
  });

  it('should pass privateStateId and the initial state when private_state_id is configured', async () => {
    vi.mocked(deployContract).mockResolvedValue(fakeDeployTxResult());
    await executeDeploy(args({ private_state_id: 'counter-state' }));
    expect(deployContract).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        privateStateId: 'counter-state',
        initialPrivateState: { seeded: true },
      }),
    );
  });

  it('should wrap a midnight-js failure in DeployTxFailedError, keeping the cause', async () => {
    const cause = new Error('chain rejected');
    vi.mocked(deployContract).mockRejectedValue(cause);
    const thrown = await executeDeploy(args()).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(DeployTxFailedError);
    expect((thrown as DeployTxFailedError).message).toBe(
      'Deploy of "Counter" failed: chain rejected',
    );
    // The original failure stays reachable for CLI stack traces.
    expect((thrown as DeployTxFailedError).cause).toBe(cause);
  });

  it('should render a tagged wallet-SDK rejection in the wrapped message', async () => {
    // midnight-js surfaces wallet-SDK rejections verbatim; they are
    // tagged records with no `.message` reachable via `(e as Error)`.
    vi.mocked(deployContract).mockRejectedValue({
      _tag: 'Wallet.Sync',
      message: 'Could not deserialize Ledger Event',
    });
    const thrown = await executeDeploy(args()).catch((e: unknown) => e);
    expect((thrown as DeployTxFailedError).message).toBe(
      'Deploy of "Counter" failed: Wallet.Sync: Could not deserialize Ledger Event',
    );
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

describe('toDeploymentRecord', () => {
  it('should map the public tx fields and stamp an ISO timestamp', () => {
    const record = toDeploymentRecord({
      deployTxData: fakeDeployTxResult().deployTxData,
      deployer: '0xDEPLOYER',
      artifact: 'src/artifacts/Counter/Counter',
    });
    expect(record).toMatchObject({
      address: '0xCONTRACT',
      txHash: '0xHASH',
      txId: '0xTX',
      blockHeight: 1234,
      deployer: '0xDEPLOYER',
      artifact: 'src/artifacts/Counter/Counter',
    });
    expect(record.timestamp).toBe(new Date(record.timestamp).toISOString());
  });

  it('should never carry a signing key into the ledger record', () => {
    const record = toDeploymentRecord({
      deployTxData: fakeDeployTxResult().deployTxData,
      deployer: '0xDEPLOYER',
      artifact: 'Counter',
    });
    expect(Object.keys(record).sort()).toEqual([
      'address',
      'artifact',
      'blockHeight',
      'deployer',
      'timestamp',
      'txHash',
      'txId',
    ]);
  });
});
