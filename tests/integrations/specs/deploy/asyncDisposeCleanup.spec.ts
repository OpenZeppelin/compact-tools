import { Deployer } from '@openzeppelin/compact-deployer/deployer';
import { ArtifactNotFoundError } from '@openzeppelin/compact-deployer/errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployFixture } from '../../_harness/deployer.ts';
import { testLogger } from '../../_harness/logger.ts';
import { setupLocalNetwork } from '../../_harness/network.ts';
import {
  CONFIG_PATH,
  requireArtifact,
  wipeDeployments,
} from '../../_harness/paths.ts';
import { getSharedPool } from '../../_harness/walletPool.ts';

/**
 * Spec: `Deployer.prepare` accumulates owned resources into a local
 * `AsyncDisposableStack`. On failure mid-prepare — here, the
 * `MissingArtifact` contract whose artifact directory doesn't exist —
 * the stack must dispose everything acquired so far (notably the
 * `"auto"` proof-server container).
 *
 * Externally we verify two things:
 *   1. The expected `ArtifactNotFoundError` propagates out.
 *   2. A subsequent successful deploy works against an `auto` proof
 *      server, which would fail if the previous container were stuck
 *      on the underlying port.
 *
 * TODO: un-skip together with `proofServerAuto.spec.ts`. Both drive the
 * `auto` proof server, and `ProofServer.start` runs before `Artifact.load`,
 * so prepare fails on the missing compose file rather than on the
 * `ArtifactNotFoundError` this asserts.
 */
describe.skip('compact-deploy — resource cleanup on mid-prepare failure', () => {
  beforeAll(() => {
    setupLocalNetwork();
    requireArtifact('Counter');
    wipeDeployments();
  });

  afterAll(() => {
    wipeDeployments();
  });

  it('should throw ArtifactNotFoundError when the artifact directory is missing', async () => {
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
  }, 240_000);

  it('should leave the proof-server slot reusable for the next deploy', async () => {
    // If the auto container leaked, this would either fail to start a
    // fresh container or the deploy would hang waiting on the dead one.
    const result = await deployFixture('Counter', 'DAVE', {
      proofServer: 'auto',
    });
    expect(result.address).toMatch(/^[0-9a-f]+$/i);
  }, 240_000);
});
