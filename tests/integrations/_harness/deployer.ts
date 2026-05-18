import { deploy, type DeployResult } from '@openzeppelin/compact-deploy';
import { testLogger } from './logger.ts';
import { localNetworkConfig, setupLocalNetwork } from './network.ts';
import { CONFIG_PATH } from './paths.ts';
import { getSharedPool, type PoolAlias } from './walletPool.ts';

/**
 * Deploy `Counter` against the local stack using the wallet at `alias`.
 *
 * Each spec is expected to call `deployFixture` with its own alias so the
 * pipeline always reuses the same wallet for multiple deploys within that
 * spec. Sharing one wallet across multiple `deploy` calls keeps its UTXO
 * view internally consistent — a fresh `buildDeployerWallet` per deploy
 * syncs from the indexer (which may lag) and can occasionally see an
 * already-spent dust UTXO, producing a `DustDoubleSpend` rejection on
 * submission.
 *
 * Wallet lifecycle is owned by the shared pool: built and started on first
 * use, stopped via `resetSharedPool()` once at end-of-suite.
 */
export async function deployFixture(
  contract: 'Counter',
  alias: PoolAlias,
  overrides: { dryRun?: boolean; proofServer?: string } = {},
): Promise<DeployResult> {
  setupLocalNetwork();
  const wallet = await getSharedPool(localNetworkConfig()).signerFor(alias);
  return deploy({
    contract,
    network: 'local',
    configPath: CONFIG_PATH,
    logger: testLogger(),
    walletProvider: wallet,
    ...overrides,
  });
}
