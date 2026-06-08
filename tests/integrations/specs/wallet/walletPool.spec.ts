import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  localNetworkConfig,
  setupLocalNetwork,
} from '../../_harness/network.ts';
import {
  getSharedPool,
  type PoolAlias,
  PREFUNDED_SEEDS,
  resetSharedPool,
} from '../../_harness/walletPool.ts';

/**
 * Spec: every alias in `PREFUNDED_SEEDS` (DEPLOYER via TEST_MNEMONIC, the
 * four hex-seed accounts) is genesis-funded on the dev-preset node, so the
 * pool can hand out a synced wallet for each without needing the faucet.
 *
 * This is the property `compact-deploy`'s local resolution depends on —
 * if it breaks (e.g. a new node release changes the prefunded set), every
 * other spec will start failing with InsufficientFunds.
 */
describe('compact-deploy — prefunded wallet pool', () => {
  beforeAll(() => {
    setupLocalNetwork();
  });

  afterAll(async () => {
    await resetSharedPool();
  });

  const aliases = Object.keys(PREFUNDED_SEEDS) as PoolAlias[];

  it.each(
    aliases,
  )('should build a synced, funded wallet for %s', async (alias) => {
    const pool = getSharedPool(localNetworkConfig());
    const wallet = await pool.signerFor(alias);

    const coinPublicKey = wallet.getCoinPublicKey();
    expect(typeof coinPublicKey).toBe('string');
    expect((coinPublicKey as unknown as string).length).toBeGreaterThan(0);

    const encryptionPublicKey = wallet.getEncryptionPublicKey();
    expect(typeof encryptionPublicKey).toBe('string');
  }, 180_000);

  it('should return the same wallet instance for repeated `signerFor` calls', async () => {
    const pool = getSharedPool(localNetworkConfig());
    const a = await pool.signerFor('ALICE');
    const b = await pool.signerFor('ALICE');
    expect(a).toBe(b);
  });

  it('should produce distinct addresses for distinct aliases', async () => {
    const pool = getSharedPool(localNetworkConfig());
    const alice = await pool.signerFor('ALICE');
    const bob = await pool.signerFor('BOB');
    expect(alice.getCoinPublicKey()).not.toBe(bob.getCoinPublicKey());
  });
});
