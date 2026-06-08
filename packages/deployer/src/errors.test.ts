import { describe, expect, it } from 'vitest';
import {
  ArtifactNotFoundError,
  ConfigError,
  DeployError,
  DeployTxFailedError,
  IndexerUnreachableError,
  ProofServerUnreachableError,
  UnfundedWalletError,
  WalletError,
} from './errors.ts';

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

  it('should pin ProofServerUnreachableError to 4', () => {
    const e = new ProofServerUnreachableError('http://ps');
    expect(e.exitCode).toBe(4);
    expect(e.name).toBe('ProofServerUnreachableError');
    expect(e.message).toContain('http://ps');
  });

  it('should pin IndexerUnreachableError to 4', () => {
    const e = new IndexerUnreachableError('http://idx');
    expect(e.exitCode).toBe(4);
    expect(e.name).toBe('IndexerUnreachableError');
    expect(e.message).toContain('http://idx');
  });

  it('should pin DeployTxFailedError to 5', () => {
    const e = new DeployTxFailedError('rejected');
    expect(e.exitCode).toBe(5);
    expect(e.name).toBe('DeployTxFailedError');
  });
});

describe('instanceof chain', () => {
  it('should let callers branch on DeployError once for any pipeline failure', () => {
    const cases: DeployError[] = [
      new ConfigError('x'),
      new WalletError('x'),
      new ArtifactNotFoundError('x'),
      new ProofServerUnreachableError('x'),
      new IndexerUnreachableError('x'),
      new UnfundedWalletError('x'),
      new DeployTxFailedError('x'),
    ];
    for (const c of cases) {
      expect(c).toBeInstanceOf(DeployError);
      expect(c).toBeInstanceOf(Error);
    }
  });
});
