import { Deployer } from '@openzeppelin/compact-deployer/deployer';
import { ArtifactNotFoundError } from '@openzeppelin/compact-deployer/errors';
import { beforeAll, describe, expect, it } from 'vitest';
import { runningAutoProofServers } from '../../_harness/docker.ts';
import { testLogger } from '../../_harness/logger.ts';
import { setupLocalNetwork } from '../../_harness/network.ts';
import { CONFIG_PATH } from '../../_harness/paths.ts';
import { getSharedPool } from '../../_harness/walletPool.ts';

/**
 * `Deployer.prepare` accumulates owned resources into a local
 * `AsyncDisposableStack`. A failure mid-prepare must unwind it, notably the
 * `"auto"` proof-server container. The failure here is the
 * `MissingArtifact` contract, whose artifact directory does not exist.
 *
 * `ProofServer.start` runs before `Artifact.load`, so the container is
 * always up by the time the artifact turns out to be missing.
 *
 * Requires Docker.
 */
describe('compact-deploy — resource cleanup on mid-prepare failure', () => {
  beforeAll(() => {
    setupLocalNetwork();
  });

  it('should stop the proof-server container it started before failing', async () => {
    const wallet = await getSharedPool().signerFor('DAVE');

    await expect(
      Deployer.prepare({
        contract: 'MissingArtifact',
        network: 'local',
        configPath: CONFIG_PATH,
        logger: testLogger(),
        walletProvider: wallet,
        proofServer: 'auto',
      }),
    ).rejects.toThrow(ArtifactNotFoundError);

    expect(runningAutoProofServers()).toStrictEqual([]);
  }, 240_000);
});
