import {
  inMemoryPrivateStateProvider,
  syncWallet,
} from '@midnight-ntwrk/testkit-js';
import { Deployer, type DeployResult } from '@openzeppelin/compact-deployer';
import { testLogger } from './logger.ts';
import { localNetworkConfig, setupLocalNetwork } from './network.ts';
import { CONFIG_PATH } from './paths.ts';
import { getSharedPool, type PoolAlias } from './walletPool.ts';

/**
 * Fresh `inMemoryPrivateStateProvider` per call so each integration
 * deploy gets an isolated private-state store. Avoids the fcntl LOCK
 * contention `levelPrivateStateProvider` causes when the wallet pool
 * keeps multiple testkit-js wallets alive in the same process — they
 * already share the `midnight-level-db/` dir, and adding a deploy-side
 * Level handle on top reliably triggers `LEVEL_LOCKED`.
 */
export function harnessPrivateStateProvider() {
  return inMemoryPrivateStateProvider();
}

/**
 * Deploy `Counter` against the local stack using the wallet at `alias`.
 *
 * Each spec is expected to call `deployFixture` with its own alias so
 * the Deployer always reuses the same wallet for multiple deploys
 * within that spec. Sharing one wallet across multiple `deploy` calls
 * keeps its UTXO view internally consistent — a fresh
 * `WalletHandler.build` per deploy syncs from the indexer (which may
 * lag) and can occasionally see an already-spent dust UTXO, producing
 * a `DustDoubleSpend` rejection on submission.
 *
 * Wallet lifecycle is owned by the shared pool: built and started on
 * first use, stopped via `resetSharedPool()` once at end-of-suite.
 */
export async function deployFixture(
  contract: 'Counter' | 'SecondaryCounter' | 'PrivateCounter',
  alias: PoolAlias,
  overrides: { dryRun?: boolean; proofServer?: string } = {},
): Promise<DeployResult> {
  setupLocalNetwork();
  const wallet = await getSharedPool(localNetworkConfig()).signerFor(alias);
  // Wait for the wallet's UTXO view to catch up to the chain head before
  // submitting another deploy. Without this, rapid back-to-back deploys
  // with the same alias (e.g. spec A → spec B both using BOB) see
  // already-spent dust UTXOs and fail with `SubmissionError`. The wallet
  // pool keeps one wallet per alias alive for the whole suite, so its
  // sync state drifts as other specs deploy.
  await syncWallet(wallet.wallet);
  await using deployer = await Deployer.prepare({
    contract,
    network: 'local',
    configPath: CONFIG_PATH,
    logger: testLogger(),
    walletProvider: wallet,
    proofServer: overrides.proofServer,
    privateStateProvider: harnessPrivateStateProvider(),
  });
  return overrides.dryRun ? deployer.dryRun() : deployer.deploy();
}
