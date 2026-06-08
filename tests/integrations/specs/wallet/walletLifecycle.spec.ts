import { Deployer } from '@openzeppelin/compact-deployer';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  deployFixture,
  harnessPrivateStateProvider,
} from '../../_harness/deployer.ts';
import { testLogger } from '../../_harness/logger.ts';
import {
  localNetworkConfig,
  setupLocalNetwork,
} from '../../_harness/network.ts';
import {
  CONFIG_PATH,
  requireFixtureArtifact,
  wipeDeployments,
} from '../../_harness/paths.ts';
import { getSharedPool } from '../../_harness/walletPool.ts';

/**
 * Spec: when `walletProvider` is injected into `Deployer.prepare`, the
 * deployer treats the wallet as caller-owned — no `wallet.start()` at
 * acquire-time, no `wallet.stop()` on dispose. This is the contract the
 * integration suite relies on so a single pool wallet can drive many
 * back-to-back deploys without losing UTXO continuity.
 */
describe('compact-deploy — injected wallets are not touched by the deployer', () => {
  beforeAll(() => {
    setupLocalNetwork();
    requireFixtureArtifact();
    wipeDeployments();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    wipeDeployments();
  });

  it('should not call wallet.stop() when the deployer is disposed', async () => {
    const wallet = await getSharedPool(localNetworkConfig()).signerFor('ALICE');
    const stopSpy = vi.spyOn(wallet, 'stop');

    {
      await using deployer = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: CONFIG_PATH,
        logger: testLogger(),
        walletProvider: wallet,
        privateStateProvider: harnessPrivateStateProvider(),
      });
      // Deploy isn't needed to verify the lifecycle contract — preparing
      // and disposing is enough. We just want to confirm dispose doesn't
      // tear down the caller-owned wallet.
      expect(deployer.contractName).toBe('Counter');
    }

    expect(stopSpy).not.toHaveBeenCalled();
  }, 240_000);

  it('should leave the injected wallet usable after dispose', async () => {
    const wallet = await getSharedPool(localNetworkConfig()).signerFor('BOB');

    {
      await using deployer = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: CONFIG_PATH,
        logger: testLogger(),
        walletProvider: wallet,
        privateStateProvider: harnessPrivateStateProvider(),
      });
      expect(deployer.contractName).toBe('Counter');
    }

    expect(typeof wallet.getCoinPublicKey()).toBe('string');
    const followUp = await deployFixture('Counter', 'BOB');
    expect(followUp.address).toMatch(/^[0-9a-f]+$/i);
  }, 240_000);
});
