import { describe, expect, it } from 'vitest';
import {
  ArtifactNotFoundError,
  BlockLimitError,
  ConfigError,
  DeployError,
  DeploymentsFileError,
  DeployTxFailedError,
  FragmentDeployError,
  PartialDeployExistsError,
  PendingDeployExistsError,
  UnfundedWalletError,
  WalletError,
} from './errors.ts';

/** Never carried by any error; the pinning tests assert its absence. */
const SIGNING_KEY_HEX = 'aa'.repeat(32);

describe('DeployError', () => {
  it('should default to exit code 1', () => {
    const e = new DeployError('boom');
    expect(e.exitCode).toBe(1);
    expect(e.name).toBe('DeployError');
    expect(e).toBeInstanceOf(Error);
  });

  it('should accept a custom exit code', () => {
    const e = new DeployError('boom', 99);
    expect(e.exitCode).toBe(99);
  });

  it('should preserve cause via ErrorOptions', () => {
    const cause = new Error('underlying');
    const e = new DeployError('wrapper', 1, { cause });
    expect(e.cause).toBe(cause);
  });
});

describe('subclass exit codes', () => {
  it('should pin ConfigError to 2', () => {
    const e = new ConfigError('bad toml');
    expect(e.exitCode).toBe(2);
    expect(e.name).toBe('ConfigError');
    expect(e).toBeInstanceOf(DeployError);
  });

  it('should pin ArtifactNotFoundError to 2', () => {
    const e = new ArtifactNotFoundError('/x/y');
    expect(e.exitCode).toBe(2);
    expect(e.name).toBe('ArtifactNotFoundError');
    expect(e.message).toContain('/x/y');
    expect(e).toBeInstanceOf(DeployError);
  });

  it('should pin WalletError to 3', () => {
    const e = new WalletError('decrypt failed');
    expect(e.exitCode).toBe(3);
    expect(e.name).toBe('WalletError');
  });

  it('should pin UnfundedWalletError to 3 and include the address', () => {
    const e = new UnfundedWalletError('mn_addr1...');
    expect(e.exitCode).toBe(3);
    expect(e.name).toBe('UnfundedWalletError');
    expect(e.message).toContain('mn_addr1...');
  });

  it('should pin PendingDeployExistsError to 2 and name the txId and the override', () => {
    const e = new PendingDeployExistsError('Token', '0xTX');
    expect(e.exitCode).toBe(2);
    expect(e.name).toBe('PendingDeployExistsError');
    expect(e.message).toContain('Token');
    expect(e.message).toContain('0xTX');
    expect(e.message).toContain('--force');
    expect(e).toBeInstanceOf(ConfigError);
  });

  it('should pin DeployTxFailedError to 5', () => {
    const e = new DeployTxFailedError('rejected');
    expect(e.exitCode).toBe(5);
    expect(e.name).toBe('DeployTxFailedError');
  });

  it('should pin DeploymentsFileError to 6', () => {
    const e = new DeploymentsFileError('local.json is not valid JSON');
    expect(e.exitCode).toBe(6);
    expect(e.name).toBe('DeploymentsFileError');
  });
});

describe('instanceof chain', () => {
  it('should let callers branch on DeployError once for any pipeline failure', () => {
    const cases: DeployError[] = [
      new ConfigError('x'),
      new WalletError('x'),
      new ArtifactNotFoundError('x'),
      new PendingDeployExistsError('x', '0xTX'),
      new UnfundedWalletError('x'),
      new DeployTxFailedError('x'),
      new DeploymentsFileError('x'),
    ];
    for (const c of cases) {
      expect(c).toBeInstanceOf(DeployError);
      expect(c).toBeInstanceOf(Error);
    }
  });
});

describe('BlockLimitError', () => {
  it('pins the exit code to 7 and stays a tx failure', () => {
    const e = new BlockLimitError('too big');

    expect(e.exitCode).toBe(7);
    expect(e.name).toBe('BlockLimitError');
    expect(e).toBeInstanceOf(DeployTxFailedError);
  });

  it('preserves the cause', () => {
    const cause = new Error('1010 block limits');

    expect(new BlockLimitError('too big', { cause }).cause).toBe(cause);
  });
});

describe('FragmentDeployError', () => {
  const fields = {
    address: '0xADDR',
    circuitsOnChain: ['approve', 'burn'],
    circuitsPending: ['evict'],
    reason: 'insert timed out',
  };

  it('pins the exit code to 8', () => {
    const e = new FragmentDeployError(fields);

    expect(e.exitCode).toBe(8);
    expect(e.name).toBe('FragmentDeployError');
    expect(e).toBeInstanceOf(DeployError);
  });

  // INV-30
  it('names the address, both circuit lists and the resume hint', () => {
    const { message } = new FragmentDeployError(fields);

    expect(message).toContain('0xADDR');
    expect(message).toContain('On chain: approve, burn');
    expect(message).toContain('Pending: evict');
    expect(message).toContain('re-run the same deploy to resume');
  });

  // INV-30
  it('exposes the fields for --json consumers', () => {
    const e = new FragmentDeployError({ ...fields, txId: '0xTX' });

    expect(e.address).toBe('0xADDR');
    expect(e.circuitsOnChain).toStrictEqual(['approve', 'burn']);
    expect(e.circuitsPending).toStrictEqual(['evict']);
    expect(e.txId).toBe('0xTX');
    expect(e.message).toContain('Failed insert txId 0xTX');
  });

  it('renders empty circuit lists readably and omits an absent txId', () => {
    const e = new FragmentDeployError({
      ...fields,
      circuitsOnChain: [],
      circuitsPending: [],
    });

    expect(e.message).toContain('On chain: (none)');
    expect(e.message).toContain('Pending: (none)');
    expect(e.message).not.toContain('txId');
    expect(e.txId).toBeUndefined();
  });

  // INV-22
  it('keeps the signing key out of the message and the fields', () => {
    const e = new FragmentDeployError({
      ...fields,
      reason: 'insert signed and rejected',
    });

    expect(String(e)).not.toContain(SIGNING_KEY_HEX);
    expect(JSON.stringify({ ...e, message: e.message })).not.toContain(
      SIGNING_KEY_HEX,
    );
  });
});

describe('PartialDeployExistsError', () => {
  it('pins the exit code to 2 and explains both routes', () => {
    const e = new PartialDeployExistsError('Token', '0xADDR');

    expect(e.exitCode).toBe(2);
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.message).toContain('Re-run without --force to resume');
    expect(e.message).toContain('0xADDR');
  });
});
